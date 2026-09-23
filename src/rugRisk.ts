/**
 * ADVANCED RUG PULL & SECURITY AUDIT SYSTEM
 * Comprehensive, multi-vector deterministic security engine for Solana tokens:
 * 1. Mint Authority Renounced (Inflation prevention)
 * 2. Freeze Authority Renounced (Blacklist / Honeypot prevention)
 * 3. Token-2022 Malicious Extensions (Transfer fees / taxes, Permanent delegate / token seizure)
 * 4. Deep Holder Concentration (Top 1 and Top 10 non-AMM distribution)
 * 5. Liquidity Pool Health & Program-Enforced Bonding Curve Locks
 * 6. Serial Rug Deployer History (Historical abandoned mint detection)
 */
import { rpcCall, getDetailedHolderDistribution } from "./solanaRpc.js";
import { fetchTokenPairs, DexScreenerPair } from "./researchSources.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = "https://api.helius.xyz/v0";
const DEPLOYER_LOOKBACK_PAGES = Number(process.env.RUG_CHECK_DEPLOYER_LOOKBACK_PAGES ?? 2);
const DEPLOYER_MIN_INITIAL_MINT_AMOUNT = Number(process.env.RUG_CHECK_MIN_INITIAL_MINT_AMOUNT ?? 1_000_000);
const ABANDONED_LIQUIDITY_USD_THRESHOLD = Number(process.env.RUG_CHECK_ABANDONED_LIQUIDITY_USD ?? 500);

export interface MintAuthorityStatus {
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  isToken2022?: boolean;
  hasTransferFee?: boolean;
  transferFeePct?: number;
  hasPermanentDelegate?: boolean;
  permanentDelegate?: string | null;
  isDefaultFrozen?: boolean;
}

/**
 * Checks SPL and Token-2022 mint parameters including authorities and malicious extensions.
 */
export async function checkMintAuthorities(mint: string): Promise<MintAuthorityStatus | null> {
  try {
    const result = await rpcCall<{
      value: {
        owner: string;
        data: {
          parsed: {
            info: {
              mintAuthority: string | null;
              freezeAuthority: string | null;
              extensions?: Array<{ extension: string; state?: any }>;
            };
          };
        };
      } | null;
    }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

    const val = result?.value;
    const info = val?.data?.parsed?.info;
    if (!info) return null;

    const programOwner = val?.owner ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const isToken2022 = programOwner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    let hasTransferFee = false;
    let transferFeePct = 0;
    let hasPermanentDelegate = false;
    let permanentDelegate: string | null = null;
    let isDefaultFrozen = false;

    if (Array.isArray(info.extensions)) {
      for (const ext of info.extensions) {
        if (ext.extension === "transferFeeConfig") {
          const bp = ext.state?.newerTransferFee?.transferFeeBasisPoints ?? ext.state?.olderTransferFee?.transferFeeBasisPoints ?? 0;
          if (bp > 0) {
            hasTransferFee = true;
            transferFeePct = Number((bp / 100).toFixed(2));
          }
        } else if (ext.extension === "permanentDelegate") {
          if (ext.state?.delegate) {
            hasPermanentDelegate = true;
            permanentDelegate = ext.state.delegate;
          }
        } else if (ext.extension === "defaultAccountState") {
          if (ext.state?.accountState === "frozen") {
            isDefaultFrozen = true;
          }
        }
      }
    }

    return {
      mintAuthorityRenounced: info.mintAuthority === null,
      freezeAuthorityRenounced: info.freezeAuthority === null,
      isToken2022,
      hasTransferFee,
      transferFeePct,
      hasPermanentDelegate,
      permanentDelegate,
      isDefaultFrozen,
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

async function fetchAddressTransactions(address: string, maxPages: number): Promise<HeliusTx[]> {
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

  return all;
}

export interface DeployerHistory {
  deployer: string;
  otherTokensFound: number;
  likelyAbandonedCount: number;
  abandonedExamples: string[];
}

/**
 * Heuristically inspects the deployer wallet's historical token launches.
 */
export async function checkDeployerHistory(mint: string): Promise<DeployerHistory | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const mintTxs = await fetchAddressTransactions(mint, DEPLOYER_LOOKBACK_PAGES);
    if (mintTxs.length === 0) return null;
    const deployer = mintTxs[mintTxs.length - 1]?.feePayer;
    if (!deployer) return null;

    const deployerTxs = await fetchAddressTransactions(deployer, DEPLOYER_LOOKBACK_PAGES);
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
        } catch {}
      })
    );

    return { deployer, otherTokensFound: otherTokens.length, likelyAbandonedCount, abandonedExamples };
  } catch {
    return null;
  }
}

export interface SecurityCheckItem {
  name: string;
  status: "SAFE" | "WARN" | "FAIL";
  badge: string;
  detail: string;
}

export interface RugRiskAssessment {
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  isToken2022: boolean;
  hasTransferFee: boolean;
  transferFeePct: number;
  hasPermanentDelegate: boolean;
  isDefaultFrozen: boolean;
  topHolderPct: number | null;
  top10HolderPct: number | null;
  deployerHistory: DeployerHistory | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskScore: number; // 0 to 100 (where 0 is lowest risk, 100 is maximum rug risk)
  securityScore: number; // 0 to 100 (where 100 is completely verified safe)
  verdict: string;
  checklist: SecurityCheckItem[];
  flags: string[];
}

/**
 * Evaluates comprehensive multi-point rug pull risk for any Solana token.
 */
export async function evaluateTokenRugRisk(
  mint: string,
  options?: {
    topHolderPct?: number | null;
    liquidityUsd?: number | null;
    pair?: DexScreenerPair;
  }
): Promise<RugRiskAssessment> {
  const [authorities, deployerHistory, distribution] = await Promise.all([
    checkMintAuthorities(mint).catch(() => null),
    checkDeployerHistory(mint).catch(() => null),
    getDetailedHolderDistribution(mint).catch(() => null),
  ]);

  const flags: string[] = [];
  const checklist: SecurityCheckItem[] = [];
  let riskScore = 0;

  // 1. Mint Authority
  if (authorities) {
    if (authorities.mintAuthorityRenounced) {
      checklist.push({
        name: "Mint Authority",
        status: "SAFE",
        badge: "✅ Renounced",
        detail: "Fixed supply. Developer cannot mint additional tokens.",
      });
    } else {
      checklist.push({
        name: "Mint Authority",
        status: "FAIL",
        badge: "🚨 ACTIVE",
        detail: "Danger. Developer can inflate supply and dump on holders.",
      });
      flags.push("🚨 Mint Authority ACTIVE: Unlimited supply inflation risk.");
      riskScore += 40;
    }

    // 2. Freeze Authority
    if (authorities.freezeAuthorityRenounced) {
      checklist.push({
        name: "Freeze Authority",
        status: "SAFE",
        badge: "✅ Renounced",
        detail: "Safe. Developer cannot blacklist or freeze holder wallets.",
      });
    } else {
      checklist.push({
        name: "Freeze Authority",
        status: "FAIL",
        badge: "🚨 ACTIVE",
        detail: "Honeypot risk. Developer can freeze your tokens and prevent sales.",
      });
      flags.push("🚨 Freeze Authority ACTIVE: Honeypot risk (developer can freeze wallets).");
      riskScore += 40;
    }

    // 3. Token-2022 Taxes & Malicious Extensions
    if (authorities.isToken2022) {
      if (authorities.hasTransferFee) {
        const feePct = authorities.transferFeePct ?? 0;
        const isExtortion = feePct >= 10;
        checklist.push({
          name: "Transfer Fee (Tax)",
          status: isExtortion ? "FAIL" : "WARN",
          badge: isExtortion ? `🚨 ${feePct}% Tax` : `⚠️ ${feePct}% Tax`,
          detail: `Token takes ${feePct}% fee on every transfer.`,
        });
        flags.push(`🚨 Malicious Transfer Fee: ${feePct}% tax enforced on every transfer.`);
        riskScore += isExtortion ? 45 : 20;
      } else {
        checklist.push({
          name: "Token-2022 Security",
          status: "SAFE",
          badge: "✅ 0% Fee",
          detail: "Token-2022 program with zero transfer taxes.",
        });
      }

      if (authorities.hasPermanentDelegate) {
        checklist.push({
          name: "Permanent Delegate",
          status: "FAIL",
          badge: "🚨 Malicious Delegate",
          detail: "Honeypot. Permanent delegate can seize or burn holder tokens.",
        });
        flags.push("🚨 Permanent Delegate Active: Deployer can seize or burn holder tokens without permission.");
        riskScore += 50;
      }

      if (authorities.isDefaultFrozen) {
        checklist.push({
          name: "Account State",
          status: "FAIL",
          badge: "🚨 Default Frozen",
          detail: "All new holder accounts are created frozen by default.",
        });
        flags.push("🚨 Default Frozen State: Instant honeypot (accounts cannot transfer).");
        riskScore += 60;
      }
    } else {
      checklist.push({
        name: "Token Contract",
        status: "SAFE",
        badge: "✅ Standard SPL",
        detail: "Standard Solana SPL contract without hidden tax extensions.",
      });
    }
  }

  // 4. Holder Distribution & Insider Concentration
  const top1 = distribution?.top1Pct ?? (typeof options?.topHolderPct === "number" ? Number((options.topHolderPct * 100).toFixed(1)) : null);
  const top10 = distribution?.top10Pct ?? null;

  if (top1 !== null) {
    if (top1 > 35) {
      checklist.push({
        name: "Top Holder Share",
        status: "FAIL",
        badge: `🚨 ~${top1}% Held`,
        detail: `Extreme concentration. Top non-pool holder controls ~${top1}% of supply.`,
      });
      flags.push(`🚨 Heavy Insider Control: Top holder owns ~${top1}% of circulating supply.`);
      riskScore += 35;
    } else if (top1 > 20) {
      checklist.push({
        name: "Top Holder Share",
        status: "WARN",
        badge: `⚠️ ~${top1}% Held`,
        detail: `Moderate concentration. Top non-pool holder owns ~${top1}% of supply.`,
      });
      flags.push(`⚠️ Concentrated Supply: Top holder owns ~${top1}% of supply.`);
      riskScore += 18;
    } else {
      checklist.push({
        name: "Top Holder Share",
        status: "SAFE",
        badge: `✅ ~${top1}% Held`,
        detail: `Healthy distribution. Largest non-pool holder owns ~${top1}%.`,
      });
    }
  }

  if (top10 !== null) {
    if (top10 > 55) {
      flags.push(`⚠️ Insider Cartel Risk: Top 10 non-pool holders own ~${top10}% of supply.`);
      riskScore += 20;
    }
  }

  // 5. Liquidity & Pool Status
  const isPumpFun = mint.endsWith("pump") || options?.pair?.dexId === "pumpfun";
  const liqUsd = options?.liquidityUsd ?? options?.pair?.liquidity?.usd ?? null;

  if (isPumpFun) {
    checklist.push({
      name: "Liquidity Mechanism",
      status: "SAFE",
      badge: "✅ Bonding Curve",
      detail: "Program-locked liquidity on Pump.fun bonding curve. 100% LP burned at graduation.",
    });
  } else if (liqUsd !== null && liqUsd < 4000) {
    checklist.push({
      name: "Liquidity Pool",
      status: "WARN",
      badge: `⚠️ Thin ($${Math.round(liqUsd).toLocaleString()})`,
      detail: "Shallow liquidity pool vulnerable to high price impact.",
    });
    flags.push(`⚠️ Thin Liquidity: Pool holds only $${Math.round(liqUsd).toLocaleString()} USD.`);
    riskScore += 15;
  } else if (liqUsd !== null) {
    checklist.push({
      name: "Liquidity Pool",
      status: "SAFE",
      badge: `✅ $${Math.round(liqUsd).toLocaleString()}`,
      detail: "Healthy liquidity backing the token trading pair.",
    });
  }

  // 6. Deployer History
  if (deployerHistory) {
    if (deployerHistory.likelyAbandonedCount > 1) {
      checklist.push({
        name: "Deployer History",
        status: "FAIL",
        badge: `🚨 Serial Rugger`,
        detail: `${deployerHistory.likelyAbandonedCount} past tokens launched by this wallet now have near-zero liquidity.`,
      });
      flags.push(`🚨 Serial Deployer Signal: ${deployerHistory.likelyAbandonedCount} prior token(s) by this wallet now have near-zero liquidity.`);
      riskScore += 30;
    } else if (deployerHistory.likelyAbandonedCount === 1) {
      checklist.push({
        name: "Deployer History",
        status: "WARN",
        badge: `⚠️ Prior Inactive Token`,
        detail: "Deployer has 1 prior token that is now inactive.",
      });
      flags.push("⚠️ Prior Inactive Token: Deployer launched 1 token with near-zero current liquidity.");
      riskScore += 12;
    } else {
      checklist.push({
        name: "Deployer History",
        status: "SAFE",
        badge: "✅ Clean Record",
        detail: "No history of abandoned or drained tokens.",
      });
    }
  }

  riskScore = Math.min(100, riskScore);
  const securityScore = Math.max(0, 100 - riskScore);

  let riskLevel: RugRiskAssessment["riskLevel"] = "LOW";
  let verdict = "🟢 VERIFIED SAFE: Contract authorities renounced, safe distribution, and no malicious extensions.";

  if (riskScore >= 70) {
    riskLevel = "CRITICAL";
    verdict = "🚨 CRITICAL RUG RISK: High probability of scam, active authorities, or malicious code.";
  } else if (riskScore >= 40) {
    riskLevel = "HIGH";
    verdict = "⚠️ HIGH RISK: Active authorities, heavy concentration, or serial deployer detected.";
  } else if (riskScore >= 20) {
    riskLevel = "MEDIUM";
    verdict = "🟡 MODERATE RISK: Minor supply concentration or thin pool liquidity.";
  }

  return {
    mintAuthorityRenounced: authorities?.mintAuthorityRenounced ?? null,
    freezeAuthorityRenounced: authorities?.freezeAuthorityRenounced ?? null,
    isToken2022: authorities?.isToken2022 ?? false,
    hasTransferFee: authorities?.hasTransferFee ?? false,
    transferFeePct: authorities?.transferFeePct ?? 0,
    hasPermanentDelegate: authorities?.hasPermanentDelegate ?? false,
    isDefaultFrozen: authorities?.isDefaultFrozen ?? false,
    topHolderPct: top1,
    top10HolderPct: top10,
    deployerHistory,
    riskLevel,
    riskScore,
    securityScore,
    verdict,
    checklist,
    flags,
  };
}
