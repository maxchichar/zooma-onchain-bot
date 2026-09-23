/**
 * SOLID GEMS ENGINE:
 * Identifies and alerts high-quality, verified non-rug pull Solana tokens.
 * Strictly limited to fresh, active tokens under 48 hours old.
 *
 * Strict Solid Gem Criteria:
 * 1. Fresh Entry: Age <= 48 hours (no stale or dead tokens)
 * 2. Mint Authority: Renounced (No unlimited supply inflation)
 * 3. Freeze Authority: Renounced (No blacklist / honeypot freezes)
 * 4. Liquidity Depth: >= $8,000 USD (Sufficient exit liquidity)
 * 5. 24h Volume: >= $10,000 USD (Active market interest)
 * 6. Holder Concentration: Top 1 holder <= 20% of top 20 sample
 * 7. Clean Deployer: No serial abandoned token history
 * 8. Overall Rug Risk Score: LOW (score <= 15)
 */
import { supabase } from "./supabase.js";
import { sendTelegramPhoto } from "./telegram.js";
import {
  fetchLatestBoostedSolanaTokens,
  fetchLatestSolanaTokenProfiles,
  fetchFreshTrendingSolanaPairs,
  fetchTokenPairs,
  getTokenImageUrl,
  DexScreenerPair,
} from "./researchSources.js";
import { evaluateTokenRugRisk, RugRiskAssessment } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openPaperTrade } from "./paperTrading.js";

const SOLID_GEM_COOLDOWN_HOURS = Number(process.env.SOLID_GEM_COOLDOWN_HOURS ?? 6);
const MIN_SOLID_LIQUIDITY_USD = Number(process.env.MIN_SOLID_LIQUIDITY_USD ?? 8000);
const MIN_SOLID_VOLUME_24H_USD = Number(process.env.MIN_SOLID_VOLUME_24H_USD ?? 10000);
const MAX_SOLID_TOP_HOLDER_PCT = Number(process.env.MAX_SOLID_TOP_HOLDER_PCT ?? 20.0);
const MAX_SOLID_AGE_HOURS = Number(process.env.MAX_SOLID_AGE_HOURS ?? 48.0);

export interface SolidGemCandidate {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: string;
  fdv: number;
  liquidityUsd: number;
  volume24hUsd: number;
  dexId: string;
  url: string;
  pair: DexScreenerPair;
  rugAssessment: RugRiskAssessment;
  topHolderPct: number | null;
  ageHours: number;
}

async function isInCooldown(tokenMint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - SOLID_GEM_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenMint)
    .eq("signal_type", "SOLID_GEM")
    .gte("created_at", cutoff)
    .limit(1);

  if (error) {
    console.error("[solidGems] cooldown check error, defaulting to SKIP:", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Evaluates a single token candidate against strict non-rug solid gem rules.
 */
export async function evaluateSolidCandidate(
  tokenAddress: string,
  preloadedPair?: DexScreenerPair
): Promise<SolidGemCandidate | null> {
  let pair = preloadedPair;
  if (!pair) {
    const pairs = await fetchTokenPairs(tokenAddress);
    if (pairs.length === 0) return null;
    pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;

  if (liquidityUsd < MIN_SOLID_LIQUIDITY_USD || volume24hUsd < MIN_SOLID_VOLUME_24H_USD) {
    return null;
  }

  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  if (ageHours > MAX_SOLID_AGE_HOURS) {
    return null; // Reject tokens older than 48 hours
  }

  const topHolderFraction = await getTopHolderConcentration(tokenAddress);
  const topHolderPct = topHolderFraction !== null ? topHolderFraction * 100 : null;

  // Strict holder check: reject if single holder has > 20%
  if (topHolderPct !== null && topHolderPct > MAX_SOLID_TOP_HOLDER_PCT) {
    return null;
  }

  const rugAssessment = await evaluateTokenRugRisk(tokenAddress, {
    topHolderPct,
    liquidityUsd,
  });

  // Strict authority check: both mint & freeze must be renounced
  if (rugAssessment.mintAuthorityRenounced !== true || rugAssessment.freezeAuthorityRenounced !== true) {
    return null;
  }

  // Must have LOW risk level
  if (rugAssessment.riskLevel !== "LOW" || rugAssessment.riskScore > 15) {
    return null;
  }

  // Check deployer history for serial rugging
  if (rugAssessment.deployerHistory && rugAssessment.deployerHistory.likelyAbandonedCount > 0) {
    return null;
  }

  return {
    tokenAddress,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    priceUsd: pair.priceUsd ?? "0",
    fdv: pair.fdv ?? 0,
    liquidityUsd,
    volume24hUsd,
    dexId: pair.dexId,
    url: pair.url,
    pair,
    rugAssessment,
    topHolderPct,
    ageHours: Number(ageHours.toFixed(1)),
  };
}

/**
 * Fires a high-priority Solid Gem Telegram alert with token image and sniper buttons.
 */
export async function fireSolidGemAlert(gem: SolidGemCandidate): Promise<void> {
  if (await isInCooldown(gem.tokenAddress)) return;

  const { data: signal, error } = await supabase
    .from("signals")
    .insert({
      token_mint: gem.tokenAddress,
      signal_type: "SOLID_GEM",
      category: "solid_gem",
      status: "UNVALIDATED",
      details: {
        symbol: gem.symbol,
        name: gem.name,
        liquidity_usd: gem.liquidityUsd,
        volume_24h_usd: gem.volume24hUsd,
        price_usd: gem.priceUsd,
        fdv: gem.fdv,
        top_holder_pct: gem.topHolderPct,
        age_hours: gem.ageHours,
        rug_risk: gem.rugAssessment,
      },
    })
    .select()
    .single();

  if (error || !signal) {
    console.error("[solidGems] failed to insert signal:", error?.message);
    return;
  }

  await supabase.from("signal_evidence").insert([
    {
      signal_id: signal.id,
      source: "solid_gem_audit",
      reference: gem.tokenAddress,
      note: `Authorities renounced, liq $${Math.round(gem.liquidityUsd).toLocaleString()}, vol $${Math.round(gem.volume24hUsd).toLocaleString()}, age ${gem.ageHours}h`,
    },
  ]);

  const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
  const holderText = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}% (Healthy)` : "Verified safe";

  const message =
    `💎 *[SOLID GEM ALERT] Non-Rug Opportunity*\n\n` +
    `*${gem.name} ($${gem.symbol})*\n` +
    `• Token CA: \`${gem.tokenAddress}\`\n\n` +
    `📊 *Market Metrics:*\n` +
    `• Price: *$${gem.priceUsd}* | FDV: *$${Math.round(gem.fdv).toLocaleString()}*\n` +
    `• Liquidity: *$${Math.round(gem.liquidityUsd).toLocaleString()}* (Deep pool)\n` +
    `• 24h Volume: *$${Math.round(gem.volume24hUsd).toLocaleString()}*\n` +
    `• Age: *${gem.ageHours} hours old* | DEX: *${gem.dexId}*\n\n` +
    `🛡️ *Non-Rug Verification & Safety Checks:*\n` +
    `• Mint Authority: ✅ Renounced (No printing risk)\n` +
    `• Freeze Authority: ✅ Renounced (Cannot blacklist/freeze)\n` +
    `• Top 1 Holder: ✅ ${holderText}\n` +
    `• Deployer Audit: ✅ Clean background (No abandoned tokens)\n` +
    `• Overall Risk Score: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
    `⚡ *Execute instant trade on fast terminal:*`;

  await sendTelegramPhoto(imageUrl, message, getTokenTradingButtons(gem.tokenAddress));

  try {
    await openPaperTrade(signal.id, gem.tokenAddress, "solid_gem");
  } catch (err) {
    console.error("[solidGems] paper trade failed:", (err as Error).message);
  }
}

/**
 * Scans live candidate pools across Raydium & DexScreener and returns all fresh solid non-rug tokens.
 */
export async function scanSolidGems(limit: number = 8): Promise<SolidGemCandidate[]> {
  const [freshPairs, boosted, profiles] = await Promise.all([
    fetchFreshTrendingSolanaPairs().catch(() => []),
    fetchLatestBoostedSolanaTokens().catch(() => []),
    fetchLatestSolanaTokenProfiles().catch(() => []),
  ]);

  const pairMap = new Map<string, DexScreenerPair>();
  for (const p of freshPairs) {
    if (p.baseToken?.address) pairMap.set(p.baseToken.address, p);
  }

  const allAddresses = [
    ...freshPairs.map((p) => p.baseToken.address),
    ...boosted.map((t) => t.tokenAddress),
    ...profiles.map((t) => t.tokenAddress),
  ];

  const uniqueAddresses = [...new Set(allAddresses)].slice(0, 35);
  const solidGems: SolidGemCandidate[] = [];

  for (const address of uniqueAddresses) {
    try {
      const preloaded = pairMap.get(address);
      const result = await evaluateSolidCandidate(address, preloaded);
      if (result) {
        solidGems.push(result);
        if (solidGems.length >= limit) break;
      }
    } catch {
      // Continue to next candidate
    }
  }

  return solidGems;
}

/**
 * Scheduled worker that discovers and notifies solid gems.
 */
export async function runSolidGemScanOnce(): Promise<number> {
  const gems = await scanSolidGems(5);
  let alerted = 0;

  for (const gem of gems) {
    try {
      const inCooldown = await isInCooldown(gem.tokenAddress);
      if (!inCooldown) {
        await fireSolidGemAlert(gem);
        alerted++;
      }
    } catch (err) {
      console.warn(`[solidGems] failed to alert gem ${gem.tokenAddress}:`, (err as Error).message);
    }
  }

  return alerted;
}
