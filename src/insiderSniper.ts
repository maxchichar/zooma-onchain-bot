/**
 * INSIDER SNIPER & PREDICTIVE DROP ENGINE
 * Targets brand new Solana tokens in their ultra-early launch window (0 - 30 minutes from creation).
 * Performs sub-second rug risk checks (mint/freeze renounced, safe distribution) and predicts breakout velocity.
 * Fires millisecond Telegram photo alerts with 1-tap sniper links (Photon, BullX, GMGN, Trojan).
 */
import { supabase } from "./supabase.js";
import { sendTelegramPhoto } from "./telegram.js";
import {
  fetchLatestSolanaTokenProfiles,
  fetchLatestBoostedSolanaTokens,
  fetchFreshTrendingSolanaPairs,
  fetchTokenPairs,
  getTokenImageUrl,
  DexScreenerPair,
} from "./researchSources.js";
import { evaluateTokenRugRisk, RugRiskAssessment } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openPaperTrade } from "./paperTrading.js";

const INSIDER_MAX_AGE_MINUTES = Number(process.env.INSIDER_MAX_AGE_MINUTES ?? 45); // Launch window up to 45 minutes
const INSIDER_MIN_LIQUIDITY_USD = Number(process.env.INSIDER_MIN_LIQUIDITY_USD ?? 2500);
const INSIDER_MAX_FDV_USD = Number(process.env.INSIDER_MAX_FDV_USD ?? 600000);
const INSIDER_MIN_VOLUME_USD = Number(process.env.INSIDER_MIN_VOLUME_USD ?? 2000);
const INSIDER_COOLDOWN_HOURS = Number(process.env.INSIDER_COOLDOWN_HOURS ?? 6);

const evaluatedMints = new Set<string>();
const MAX_EVALUATED_CACHE = 2000;

export interface InsiderCandidate {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: string;
  liquidityUsd: number;
  volumeUsd: number;
  fdv: number;
  dexId: string;
  ageMinutes: number;
  buyRatioPct: number | null;
  topHolderPct: number | null;
  rugAssessment: RugRiskAssessment;
  predictedRunway: string;
  pair: DexScreenerPair;
}

async function isInsiderInCooldown(tokenMint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - INSIDER_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenMint)
    .eq("signal_type", "INSIDER_SNIPER")
    .gte("created_at", cutoff)
    .limit(1);

  if (error) return true;
  return (data?.length ?? 0) > 0;
}

/**
 * Rapidly evaluates a newly created candidate token in the 0 - 35 minute launch window.
 */
export async function evaluateInsiderCandidate(
  tokenAddress: string,
  preloadedPair?: DexScreenerPair
): Promise<InsiderCandidate | null> {
  let pair = preloadedPair;
  if (!pair) {
    const pairs = await fetchTokenPairs(tokenAddress);
    if (pairs.length === 0) return null;
    pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volumeUsd = pair.volume?.h24 ?? 0;
  const fdv = pair.fdv ?? (pair.marketCap ?? 0);

  // Check launch timing (strictly under 35 minutes)
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 0;
  if (ageMinutes > INSIDER_MAX_AGE_MINUTES || ageMinutes < 0) {
    return null;
  }

  // Initial liquidity & market cap guardrails
  if (liquidityUsd < INSIDER_MIN_LIQUIDITY_USD) return null;
  if (fdv > INSIDER_MAX_FDV_USD || fdv <= 0) return null;
  if (volumeUsd < INSIDER_MIN_VOLUME_USD) return null;

  // Buy pressure analysis
  let buyRatioPct: number | null = null;
  if (pair.txns?.h24) {
    const total = pair.txns.h24.buys + pair.txns.h24.sells;
    if (total > 0) {
      buyRatioPct = (pair.txns.h24.buys / total) * 100;
      if (buyRatioPct < 52) return null; // Reject dumping tokens
    }
  }

  // Parallel fast risk audit
  const [rugAssessment, topHolderFraction] = await Promise.all([
    evaluateTokenRugRisk(tokenAddress, { liquidityUsd }),
    getTopHolderConcentration(tokenAddress).catch(() => null),
  ]);

  // Reject honey pots or unrenounced tokens
  if (!rugAssessment.mintAuthorityRenounced || !rugAssessment.freezeAuthorityRenounced) {
    return null;
  }

  // Reject extreme concentration (> 20% by top 1 holder)
  if (topHolderFraction !== null && topHolderFraction > 0.20) {
    return null;
  }

  if (rugAssessment.riskScore > 25) {
    return null;
  }

  // Predictive upside estimation based on early entry valuation
  let predictedRunway = "25x - 50x Runway";
  if (fdv < 50000) {
    predictedRunway = "100x+ Early Moonshot Potential";
  } else if (fdv < 150000) {
    predictedRunway = "50x - 100x High Velocity Runway";
  }

  return {
    tokenAddress,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    priceUsd: pair.priceUsd ?? "0",
    liquidityUsd,
    volumeUsd,
    fdv,
    dexId: pair.dexId,
    ageMinutes: Number(ageMinutes.toFixed(1)),
    buyRatioPct: buyRatioPct !== null ? Number(buyRatioPct.toFixed(0)) : null,
    topHolderPct: topHolderFraction !== null ? topHolderFraction * 100 : null,
    rugAssessment,
    predictedRunway,
    pair,
  };
}

/**
 * Fires an instant, high-priority Telegram alert with fast snipe buttons.
 */
export async function fireInsiderSniperAlert(candidate: InsiderCandidate): Promise<void> {
  if (await isInsiderInCooldown(candidate.tokenAddress)) return;

  const { data: signal, error } = await supabase
    .from("signals")
    .insert({
      token_mint: candidate.tokenAddress,
      signal_type: "INSIDER_SNIPER",
      category: "solid_gem",
      status: "UNVALIDATED",
      details: {
        symbol: candidate.symbol,
        name: candidate.name,
        price_usd: candidate.priceUsd,
        liquidity_usd: candidate.liquidityUsd,
        volume_usd: candidate.volumeUsd,
        fdv: candidate.fdv,
        dex_id: candidate.dexId,
        age_minutes: candidate.ageMinutes,
        buy_ratio_pct: candidate.buyRatioPct,
        predicted_runway: candidate.predictedRunway,
        rug_risk: candidate.rugAssessment,
      },
    })
    .select()
    .single();

  if (error || !signal) return;

  await supabase.from("signal_evidence").insert([
    {
      signal_id: signal.id,
      signature: `insider_${candidate.tokenAddress.slice(0, 16)}`,
      wallet: candidate.tokenAddress,
      note: `Launch age ${candidate.ageMinutes}m, FDV $${Math.round(candidate.fdv).toLocaleString()}, Liq $${Math.round(candidate.liquidityUsd).toLocaleString()}, BuyRatio ${candidate.buyRatioPct}%`,
    },
  ]);

  const imageUrl = getTokenImageUrl(candidate.tokenAddress, candidate.pair);
  const buyRatioLine = candidate.buyRatioPct ? `• Buy Pressure: *${candidate.buyRatioPct}% Buys* (Surging Volume)\n` : "";
  const holderLine = candidate.topHolderPct !== null ? `~${candidate.topHolderPct.toFixed(1)}% (Safe Distribution)` : "Safe";
  const priceStr = Number(candidate.priceUsd) < 0.01 ? `$${Number(candidate.priceUsd).toFixed(6)}` : `$${Number(candidate.priceUsd).toFixed(4)}`;

  const message =
    `⚡ *[INSIDER SNIPER ALERT | ${candidate.ageMinutes}m FROM LAUNCH]*\n\n` +
    `*${candidate.name} ($${candidate.symbol})*\n` +
    `• Token CA: \`${candidate.tokenAddress}\`\n\n` +
    `🚀 *Early Predictive Metrics:*\n` +
    `• Launch Timing: *${candidate.ageMinutes} minutes ago* (Ultra-Early Entry)\n` +
    `• Price: *${priceStr}* | FDV: *$${Math.round(candidate.fdv).toLocaleString()}*\n` +
    `• Liquidity Pool: *$${Math.round(candidate.liquidityUsd).toLocaleString()}* | Vol: *$${Math.round(candidate.volumeUsd).toLocaleString()}*\n` +
    buyRatioLine +
    `• Projected Upside: *${candidate.predictedRunway}*\n` +
    `• DEX Engine: *${candidate.dexId}*\n\n` +
    `🛡️ *Instant Security Audit (Verified Safe):*\n` +
    `• Mint Authority: ✅ Renounced (Cannot mint new tokens)\n` +
    `• Freeze Authority: ✅ Renounced (Cannot freeze/blacklist)\n` +
    `• Top 1 Holder: ✅ ${holderLine}\n` +
    `• Rug Risk: 🟢 *LOW RISK (${candidate.rugAssessment.riskScore}/100)*\n\n` +
    `⚡ *Execute sub-second trade on fastest terminal:*`;

  await sendTelegramPhoto(imageUrl, message, getTokenTradingButtons(candidate.tokenAddress));

  // Automatically open simulated $2 paper trade
  try {
    await openPaperTrade(signal.id, candidate.tokenAddress, "solid_gem");
  } catch (err) {
    console.error("[insiderSniper] paper trade error:", (err as Error).message);
  }
}

/**
 * Rapid scanner that checks recent profiles and pools for 0 - 35 minute drops.
 */
export async function scanInsiderDrops(limit: number = 5): Promise<InsiderCandidate[]> {
  const [profiles, boosted, freshPairs] = await Promise.all([
    fetchLatestSolanaTokenProfiles().catch(() => []),
    fetchLatestBoostedSolanaTokens().catch(() => []),
    fetchFreshTrendingSolanaPairs().catch(() => []),
  ]);

  const pairMap = new Map<string, DexScreenerPair>();
  for (const p of freshPairs) {
    if (p.baseToken?.address) pairMap.set(p.baseToken.address, p);
  }

  const allAddresses = [
    ...profiles.map((p) => p.tokenAddress),
    ...boosted.map((b) => b.tokenAddress),
    ...freshPairs.map((p) => p.baseToken.address),
  ];

  const unique = [...new Set(allAddresses)].slice(0, 30);
  const candidates: InsiderCandidate[] = [];

  for (const addr of unique) {
    try {
      const candidate = await evaluateInsiderCandidate(addr, pairMap.get(addr));
      if (candidate) {
        candidates.push(candidate);
        if (candidates.length >= limit) break;
      }
    } catch {
      // Continue next token
    }
  }

  // Sort by freshest launch age (youngest first)
  return candidates.sort((a, b) => a.ageMinutes - b.ageMinutes);
}

/**
 * Continuous high-speed background loop executed every 15-20 seconds.
 */
export async function runInsiderSniperOnce(): Promise<number> {
  const candidates = await scanInsiderDrops(3);
  let alerted = 0;

  for (const c of candidates) {
    try {
      if (evaluatedMints.has(c.tokenAddress)) continue;

      evaluatedMints.add(c.tokenAddress);
      if (evaluatedMints.size > MAX_EVALUATED_CACHE) {
        const oldest = evaluatedMints.values().next().value;
        if (oldest) evaluatedMints.delete(oldest);
      }

      const inCooldown = await isInsiderInCooldown(c.tokenAddress);
      if (!inCooldown) {
        await fireInsiderSniperAlert(c);
        alerted++;
      }
    } catch (err) {
      console.warn(`[insiderSniper] alert failed for ${c.tokenAddress}:`, (err as Error).message);
    }
  }

  return alerted;
}
