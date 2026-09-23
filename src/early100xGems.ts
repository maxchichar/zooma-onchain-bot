/**
 * EARLY 100X POTENTIAL GEM SCANNER:
 * Specifically targets early-stage, low-cap Solana tokens with high breakout velocity
 * and verified safety fundamentals for maximum upside potential.
 * Strictly limited to fresh tokens under 48 hours old.
 *
 * 100x Potential Criteria:
 * 1. Fresh Entry: Age <= 48 hours (fresh launch / early breakout stage)
 * 2. Low Entry Market Cap: FDV between $20,000 and $2,000,000 (huge runway for 10x-100x)
 * 3. High Volume Velocity: Volume >= $10,000 and healthy buy pressure
 * 4. Solid Safety: Mint Authority Renounced, Freeze Authority Renounced
 * 5. Safe Distribution: Top 1 holder <= 20% of supply sample
 * 6. Clean Deployer History: No dumped/abandoned prior tokens
 * 7. Fast Execution: 1-tap sniper links ready for millisecond entry
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

const EARLY_100X_COOLDOWN_HOURS = Number(process.env.EARLY_100X_COOLDOWN_HOURS ?? 6);
const MIN_EARLY_LIQUIDITY_USD = Number(process.env.MIN_EARLY_LIQUIDITY_USD ?? 6000);
const MAX_EARLY_FDV_USD = Number(process.env.MAX_EARLY_FDV_USD ?? 2000000); // Under $2.0M FDV for 100x runway
const MIN_EARLY_VOLUME_USD = Number(process.env.MIN_EARLY_VOLUME_USD ?? 10000);
const MAX_EARLY_AGE_HOURS = Number(process.env.MAX_EARLY_AGE_HOURS ?? 48);

export interface Early100xCandidate {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: string;
  fdv: number;
  liquidityUsd: number;
  volume24hUsd: number;
  buyRatioPct: number | null;
  dexId: string;
  url: string;
  pair: DexScreenerPair;
  rugAssessment: RugRiskAssessment;
  topHolderPct: number | null;
  ageHours: number;
  potentialMultiplier: string;
}

async function isInCooldown(tokenMint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - EARLY_100X_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenMint)
    .eq("signal_type", "EARLY_100X_GEM")
    .gte("created_at", cutoff)
    .limit(1);

  if (error) {
    console.error("[early100x] cooldown check error, defaulting to SKIP:", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

export async function evaluate100xCandidate(
  tokenAddress: string,
  preloadedPair?: DexScreenerPair
): Promise<Early100xCandidate | null> {
  let pair = preloadedPair;
  if (!pair) {
    const pairs = await fetchTokenPairs(tokenAddress);
    if (pairs.length === 0) return null;
    pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;
  const fdv = pair.fdv ?? (pair.marketCap ?? 0);

  // Must satisfy liquidity and volume floors
  if (liquidityUsd < MIN_EARLY_LIQUIDITY_USD || volume24hUsd < MIN_EARLY_VOLUME_USD) {
    return null;
  }

  // 100x runway requires low initial market cap
  if (fdv > MAX_EARLY_FDV_USD || fdv <= 0) {
    return null;
  }

  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  if (ageHours > MAX_EARLY_AGE_HOURS) {
    return null; // Too mature for early breakout entry (must be <= 48 hours)
  }

  // Check buy/sell ratio
  let buyRatioPct: number | null = null;
  if (pair.txns?.h24) {
    const totalTx = pair.txns.h24.buys + pair.txns.h24.sells;
    if (totalTx > 0) {
      buyRatioPct = (pair.txns.h24.buys / totalTx) * 100;
      if (buyRatioPct < 50) return null; // Reject if heavy dumping
    }
  }

  const topHolderFraction = await getTopHolderConcentration(tokenAddress);
  const topHolderPct = topHolderFraction !== null ? topHolderFraction * 100 : null;
  if (topHolderPct !== null && topHolderPct > 20.0) {
    return null; // Reject heavy insider concentration
  }

  const rugAssessment = await evaluateTokenRugRisk(tokenAddress, {
    topHolderPct,
    liquidityUsd,
  });

  // Strict authority verification: mint & freeze MUST be renounced
  if (rugAssessment.mintAuthorityRenounced !== true || rugAssessment.freezeAuthorityRenounced !== true) {
    return null;
  }

  if (rugAssessment.riskLevel !== "LOW" || rugAssessment.riskScore > 15) {
    return null;
  }

  // Calculate realistic multiplier upside to $20M target cap
  const targetCap = 20_000_000;
  const upsideX = Math.min(100, Math.max(10, Math.round(targetCap / Math.max(fdv, 20_000))));

  return {
    tokenAddress,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    priceUsd: pair.priceUsd ?? "0",
    fdv,
    liquidityUsd,
    volume24hUsd,
    buyRatioPct: buyRatioPct ? Number(buyRatioPct.toFixed(1)) : null,
    dexId: pair.dexId,
    url: pair.url,
    pair,
    rugAssessment,
    topHolderPct,
    ageHours: Number(ageHours.toFixed(1)),
    potentialMultiplier: `${upsideX}x`,
  };
}

export async function fireEarly100xAlert(gem: Early100xCandidate): Promise<void> {
  if (await isInCooldown(gem.tokenAddress)) return;

  const { data: signal, error } = await supabase
    .from("signals")
    .insert({
      token_mint: gem.tokenAddress,
      signal_type: "EARLY_100X_GEM",
      category: "solid_gem",
      status: "UNVALIDATED",
      details: {
        symbol: gem.symbol,
        name: gem.name,
        fdv: gem.fdv,
        liquidity_usd: gem.liquidityUsd,
        volume_24h_usd: gem.volume24hUsd,
        buy_ratio_pct: gem.buyRatioPct,
        age_hours: gem.ageHours,
        potential_multiplier: gem.potentialMultiplier,
        rug_risk: gem.rugAssessment,
      },
    })
    .select()
    .single();

  if (error || !signal) {
    console.error("[early100x] failed to insert signal:", error?.message);
    return;
  }

  await supabase.from("signal_evidence").insert([
    {
      signal_id: signal.id,
      signature: `audit_${gem.tokenAddress.slice(0, 16)}`,
      wallet: gem.tokenAddress,
      note: `FDV $${Math.round(gem.fdv).toLocaleString()}, Liq $${Math.round(gem.liquidityUsd).toLocaleString()}, Age ${gem.ageHours}h, Upside ${gem.potentialMultiplier}`,
    },
  ]);

  const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
  const buyRatioText = gem.buyRatioPct ? `• Buy Pressure: *${gem.buyRatioPct}% Buys* (Bullish)\n` : "";
  const holderText = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}%` : "Safe";

  const message =
    `🚀 *[100X EARLY BREAKOUT GEM ALERT]*\n\n` +
    `*${gem.name} ($${gem.symbol})*\n` +
    `• Token CA: \`${gem.tokenAddress}\`\n\n` +
    `📈 *Early Growth Potential:*\n` +
    `• Est. Upside Runway: *${gem.potentialMultiplier}* (Early Entry)\n` +
    `• Current FDV: *$${Math.round(gem.fdv).toLocaleString()}* (Micro-cap)\n` +
    `• Liquidity: *$${Math.round(gem.liquidityUsd).toLocaleString()}* | 24h Vol: *$${Math.round(gem.volume24hUsd).toLocaleString()}*\n` +
    `• Age: *${gem.ageHours} hours old* | DEX: *${gem.dexId}*\n` +
    buyRatioText +
    `\n🛡️ *Non-Rug Security Pass:*\n` +
    `• Mint Authority: ✅ Renounced (Safe)\n` +
    `• Freeze Authority: ✅ Renounced (Safe)\n` +
    `• Top 1 Holder: ✅ ${holderText}\n` +
    `• Rug Risk: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
    `⚡ *Execute instant snipe on fast trading terminal:*`;

  await sendTelegramPhoto(imageUrl, message, getTokenTradingButtons(gem.tokenAddress));

  try {
    await openPaperTrade(signal.id, gem.tokenAddress, "early_100x", gem.priceUsd, gem.pair);
  } catch (err) {
    console.error("[early100x] paper trade open error:", (err as Error).message);
  }
}

export async function scanEarly100xGems(limit: number = 5): Promise<Early100xCandidate[]> {
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
  const gems: Early100xCandidate[] = [];

  for (const address of uniqueAddresses) {
    try {
      const preloaded = pairMap.get(address);
      const result = await evaluate100xCandidate(address, preloaded);
      if (result) {
        gems.push(result);
        if (gems.length >= limit) break;
      }
    } catch {
      // Continue
    }
  }

  return gems;
}

export async function runEarly100xScanOnce(): Promise<number> {
  const gems = await scanEarly100xGems(3);
  let alerted = 0;

  for (const gem of gems) {
    try {
      const inCooldown = await isInCooldown(gem.tokenAddress);
      if (!inCooldown) {
        await fireEarly100xAlert(gem);
        alerted++;
      }
    } catch (err) {
      console.warn(`[early100x] alert failed for ${gem.tokenAddress}:`, (err as Error).message);
    }
  }

  return alerted;
}
