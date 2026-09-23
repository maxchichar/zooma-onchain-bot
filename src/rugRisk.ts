/**
 * RUG RISK CHECKS — goes beyond the basic holder-concentration check
 * already in research.ts. Two checks, both free, both deterministic:
 *
 * 1. MINT & FREEZE AUTHORITY STATUS. One of the clearest, most reliable
 *    rug indicators that exists on Solana, and it's a single free RPC
 *    call. Every SPL token has a "mint authority" (who can create more
 *    of the token) and a "freeze authority" (who can freeze a specific
 *    wallet's token account, blocking transfers). A legitimate project
 *    renounces both (sets them to null) once the token launches. If
 *    either is still set to a real address:
 *      - mint authority NOT renounced: the deployer can print unlimited
 *        additional tokens whenever they want and dump them on holders.
 *      - freeze authority NOT renounced: the deployer can freeze YOUR
 *        wallet's tokens, preventing you from ever selling.
 *    This is unambiguous and checkable — no heuristic involved.
 *
 * 2. DEPLOYER HISTORY. Approximate, heuristic, and labeled as such
 *    everywhere it's surfaced. Finds the wallet that likely deployed
 *    this token (the earliest transaction touching the mint, within a
 *    capped lookback — for an old, high-activity mint this could miss
 *    the true origin, which is fine since this is aimed at freshly
 *    launched meme coins). Then looks at that wallet's other token
 *    activity: a deployer wallet typically receives the full initial
 *    supply of a token it creates, so a large token transfer INTO the
 *    deployer for a mint not otherwise seen is used as a proxy for
 *    "this wallet launched this token too." Each such token's CURRENT
 *    liquidity is checked — near-zero liquidity on a token this wallet
 *    previously launched is the classic serial-rug-deployer pattern.
 *    This is a signal, not a verdict: false positives (a legitimate
 *    builder who's launched several tokens, one of which just didn't
 *    take off) are possible and expected.
 */
import { rpcCall } from "./solanaRpc.js";
import { fetchTokenPairs } from "./researchSources.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = "https://api.helius.xyz/v0";
const DEPLOYER_LOOKBACK_PAGES = Number(process.env.RUG_CHECK_DEPLOYER_LOOKBACK_PAGES ?? 2);
const DEPLOYER_MIN_INITIAL_MINT_AMOUNT = Number(process.env.RUG_CHECK_MIN_INITIAL_MINT_AMOUNT ?? 1_000_000);
const ABANDONED_LIQUIDITY_USD_THRESHOLD = Number(process.env.RUG_CHECK_ABANDONED_LIQUIDITY_USD ?? 500);

export interface MintAuthorityStatus {
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
}

/** Single free RPC call. Returns null only on an RPC failure, not on "authority exists" (that's a real, valid result). */
export async function checkMintAuthorities(mint: string): Promise<MintAuthorityStatus | null> {
  try {
    const result = await rpcCall<{
      value: { data: { parsed: { info: { mintAuthority: string | null; freezeAuthority: string | null } } } } | null;
    }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

    const info = result?.value?.data?.parsed?.info;
    if (!info) return null;

    return {
      mintAuthorityRenounced: info.mintAuthority === null,
      freezeAuthorityRenounced: info.freezeAuthority === null,
    };
  } catch (err) {
    console.warn(`[rugRisk] mint authority check failed for ${mint}:`, (err as Error).message);
    return null;
  }
}

interface HeliusTx {
  signature: string;
  feePayer?: string;
  tokenTransfers?: { fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number }[];
}

async function fetchAddressTransactions(address: string, maxPages: number, direction: "newest" | "oldest"): Promise<HeliusTx[]> {
  if (!HELIUS_API_KEY) return [];
  const all: HeliusTx[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`);
    url.searchParams.set("api-key", HELIUS_API_KEY);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res || !res.ok) break;
    const batch = (await res.json().catch(() => [])) as HeliusTx[];
    if (!batch.length) break;

    all.push(...batch);
    before = batch[batch.length - 1].signature;
  }

  void direction;
  return all;
}

export interface DeployerHistory {
  deployer: string;
  otherTokensFound: number;
  likelyAbandonedCount: number;
  abandonedExamples: string[]; // token mints, capped to a few for the evidence line
}

/**
 * Best-effort. Returns null if Helius isn't configured, the mint has no
 * discoverable transaction history within the lookback, or no deployer
 * could be identified.
 */
export async function checkDeployerHistory(mint: string): Promise<DeployerHistory | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const mintTxs = await fetchAddressTransactions(mint, DEPLOYER_LOOKBACK_PAGES, "oldest");
    if (mintTxs.length === 0) return null;
    const deployer = mintTxs[mintTxs.length - 1]?.feePayer;
    if (!deployer) return null;

    const deployerTxs = await fetchAddressTransactions(deployer, DEPLOYER_LOOKBACK_PAGES, "newest");
    const otherMints = new Map<string, number>();

    for (const tx of deployerTxs) {
      for (const t of tx.tokenTransfers ?? []) {
        if (t.toUserAccount !== deployer || t.mint === mint) continue;
        if (t.tokenAmount < DEPLOYER_MIN_INITIAL_MINT_AMOUNT) continue;
        const existing = otherMints.get(t.mint) ?? 0;
        otherMints.set(t.mint, Math.max(existing, t.tokenAmount));
      }
    }

    const otherTokens = [...otherMints.keys()];
    let likelyAbandonedCount = 0;
    const abandonedExamples: string[] = [];

    // Parallel check of top 4 other tokens
    const sample = otherTokens.slice(0, 4);
    await Promise.all(
      sample.map(async (otherMint) => {
        try {
          const pairs = await fetchTokenPairs(otherMint);
          const bestLiquidity = pairs.reduce((max, p) => Math.max(max, p.liquidity?.usd ?? 0), 0);
          if (bestLiquidity < ABANDONED_LIQUIDITY_USD_THRESHOLD) {
            likelyAbandonedCount++;
            if (abandonedExamples.length < 3) abandonedExamples.push(otherMint);
          }
        } catch {
          // Skip unpriceable
        }
      })
    );

    return { deployer, otherTokensFound: otherTokens.length, likelyAbandonedCount, abandonedExamples };
  } catch {
    return null;
  }
}

export interface RugRiskAssessment {
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  topHolderPct: number | null;
  deployerHistory: DeployerHistory | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskScore: number; // 0 to 100
  verdict: string;
  flags: string[];
}

/**
 * Evaluates comprehensive rug pull risk for any Solana token.
 */
export async function evaluateTokenRugRisk(
  mint: string,
  options?: { topHolderPct?: number | null; liquidityUsd?: number | null }
): Promise<RugRiskAssessment> {
  const [authorities, deployerHistory] = await Promise.all([
    checkMintAuthorities(mint).catch(() => null),
    checkDeployerHistory(mint).catch(() => null),
  ]);

  const flags: string[] = [];
  let score = 0;

  if (authorities) {
    if (!authorities.mintAuthorityRenounced) {
      flags.push("🚨 Mint Authority ACTIVE: Deployer can print unlimited supply.");
      score += 40;
    }
    if (!authorities.freezeAuthorityRenounced) {
      flags.push("🚨 Freeze Authority ACTIVE: Deployer can blacklist/freeze holder wallets.");
      score += 40;
    }
  }

  const topHolder = options?.topHolderPct;
  if (typeof topHolder === "number") {
    if (topHolder > 40) {
      flags.push(`🚨 Heavy Insider Control: Top holder owns ~${topHolder.toFixed(1)}% of top-20 balance.`);
      score += 35;
    } else if (topHolder > 20) {
      flags.push(`⚠️ Concentrated Supply: Top holder owns ~${topHolder.toFixed(1)}% of top-20 balance.`);
      score += 20;
    }
  }

  if (deployerHistory && deployerHistory.likelyAbandonedCount > 0) {
    flags.push(`⚠️ Serial Deployer Signal: ${deployerHistory.likelyAbandonedCount} prior token(s) by this wallet now have near-zero liquidity.`);
    score += 25;
  }

  if (options?.liquidityUsd !== undefined && options.liquidityUsd !== null && options.liquidityUsd < 5000) {
    flags.push(`⚠️ Thin Liquidity: Pool holds only $${Math.round(options.liquidityUsd).toLocaleString()} USD.`);
    score += 15;
  }

  score = Math.min(100, score);

  let riskLevel: RugRiskAssessment["riskLevel"] = "LOW";
  let verdict = "🟢 LOW RUG RISK: Authorities renounced and no major flags.";

  if (score >= 70) {
    riskLevel = "CRITICAL";
    verdict = "🚨 CRITICAL RUG RISK: High probability of scam or dump.";
  } else if (score >= 40) {
    riskLevel = "HIGH";
    verdict = "⚠️ HIGH RISK: Active authorities or heavy concentration detected.";
  } else if (score >= 20) {
    riskLevel = "MEDIUM";
    verdict = "🟡 MEDIUM RISK: Minor concentration or low liquidity.";
  }

  return {
    mintAuthorityRenounced: authorities?.mintAuthorityRenounced ?? null,
    freezeAuthorityRenounced: authorities?.freezeAuthorityRenounced ?? null,
    topHolderPct: topHolder ?? null,
    deployerHistory,
    riskLevel,
    riskScore: score,
    verdict,
    flags,
  };
}
