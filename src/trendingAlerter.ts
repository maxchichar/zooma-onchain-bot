/**
 * TRENDING TOKEN ENGINE:
 * Fetches up to 15 live trending Solana tokens with individual images, DEX stats,
 * and automated 24/7 background alerting for newly trending breakout tokens.
 */
import { supabase } from "./supabase.js";
import { sendTelegramPhoto } from "./telegram.js";
import {
  fetchFreshTrendingSolanaPairs,
  fetchLatestBoostedSolanaTokens,
  fetchLatestSolanaTokenProfiles,
  fetchTokenPairs,
  getTokenImageUrl,
  DexScreenerPair,
} from "./researchSources.js";
import { evaluateTokenRugRisk, RugRiskAssessment } from "./rugRisk.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openTrendingPaperTrade } from "./paperTrading.js";

const TRENDING_COOLDOWN_HOURS = Number(process.env.TRENDING_COOLDOWN_HOURS ?? 6);

export interface TrendingTokenDetail {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: string;
  liquidityUsd: number;
  volume24hUsd: number;
  fdv: number;
  dexId: string;
  ageHours: number;
  imageUrl: string;
  pair: DexScreenerPair;
}

async function isTrendingInCooldown(tokenMint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - TRENDING_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenMint)
    .eq("signal_type", "TRENDING_BREAKOUT")
    .gte("created_at", cutoff)
    .limit(1);

  if (error) return true;
  return (data?.length ?? 0) > 0;
}

/**
 * Fetches up to 15 live trending Solana tokens with complete metadata and photos.
 */
export async function fetchTopTrendingSolanaTokens(limit: number = 15): Promise<TrendingTokenDetail[]> {
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

  const unique = [...new Set(allAddresses)];
  const trendingList: TrendingTokenDetail[] = [];

  for (const addr of unique) {
    try {
      let pair = pairMap.get(addr);
      if (!pair) {
        const pairs = await fetchTokenPairs(addr);
        if (pairs.length > 0) {
          pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
        }
      }

      if (!pair) continue;

      const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
      const imageUrl = getTokenImageUrl(addr, pair);

      trendingList.push({
        tokenAddress: addr,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        priceUsd: pair.priceUsd ?? "0",
        liquidityUsd: pair.liquidity?.usd ?? 0,
        volume24hUsd: pair.volume?.h24 ?? 0,
        fdv: pair.fdv ?? (pair.marketCap ?? 0),
        dexId: pair.dexId,
        ageHours: Number(ageHours.toFixed(1)),
        imageUrl,
        pair,
      });

      if (trendingList.length >= limit) break;
    } catch {
      // Continue
    }
  }

  // Sort by highest 24h volume
  return trendingList.sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, limit);
}

/**
 * Fires an automated real-time alert for a newly trending breakout token.
 */
export async function fireTrendingBreakoutAlert(token: TrendingTokenDetail): Promise<void> {
  if (await isTrendingInCooldown(token.tokenAddress)) return;

  const rugAudit = await evaluateTokenRugRisk(token.tokenAddress, { liquidityUsd: token.liquidityUsd });

  const { data: signal, error } = await supabase
    .from("signals")
    .insert({
      token_mint: token.tokenAddress,
      signal_type: "TRENDING_BREAKOUT",
      category: "trending_trade",
      status: "UNVALIDATED",
      details: {
        symbol: token.symbol,
        name: token.name,
        price_usd: token.priceUsd,
        liquidity_usd: token.liquidityUsd,
        volume_24h_usd: token.volume24hUsd,
        fdv: token.fdv,
        dex_id: token.dexId,
        age_hours: token.ageHours,
        rug_risk: rugAudit,
      },
    })
    .select()
    .single();

  if (error || !signal) return;

  const priceStr = Number(token.priceUsd) < 0.01 ? `$${Number(token.priceUsd).toFixed(6)}` : `$${Number(token.priceUsd).toFixed(4)}`;

  const message =
    `🔥 *[TRENDING BREAKOUT ALERT]*\n\n` +
    `*${token.name} ($${token.symbol})*\n` +
    `• Token CA: \`${token.tokenAddress}\`\n\n` +
    `📊 *Trending Metrics:*\n` +
    `• Price: *${priceStr}* | FDV: *$${Math.round(token.fdv).toLocaleString()}*\n` +
    `• 24h Volume: *$${Math.round(token.volume24hUsd).toLocaleString()}* (High Velocity)\n` +
    `• Liquidity: *$${Math.round(token.liquidityUsd).toLocaleString()}* | Age: *${token.ageHours}h*\n` +
    `• DEX: *${token.dexId}*\n\n` +
    `🛡️ *Security Status:* ${rugAudit.verdict}\n` +
    `• Mint Authority: ${rugAudit.mintAuthorityRenounced ? "✅ Renounced" : "🚨 Active"}\n` +
    `• Freeze Authority: ${rugAudit.freezeAuthorityRenounced ? "✅ Renounced" : "🚨 Active"}\n\n` +
    `⚡ *Execute instant snipe on fast trading terminal:*`;

  await sendTelegramPhoto(token.imageUrl, message, getTokenTradingButtons(token.tokenAddress));

  // Automatically open simulated $2 paper trade position
  try {
    await openTrendingPaperTrade(token.tokenAddress, token.priceUsd);
  } catch (err) {
    console.error("[trendingAlerter] paper trade error:", (err as Error).message);
  }
}

/**
 * Background worker that auto-scans and auto-alerts top trending tokens.
 */
export async function runTrendingAutoAlertOnce(): Promise<number> {
  const trending = await fetchTopTrendingSolanaTokens(15);
  let alerted = 0;

  for (const token of trending.slice(0, 5)) {
    try {
      if (token.volume24hUsd >= 15000 && token.liquidityUsd >= 5000 && token.ageHours <= 48) {
        const inCooldown = await isTrendingInCooldown(token.tokenAddress);
        if (!inCooldown) {
          await fireTrendingBreakoutAlert(token);
          alerted++;
        }
      }
    } catch (err) {
      console.warn(`[trendingAlerter] alert failed for ${token.tokenAddress}:`, (err as Error).message);
    }
  }

  return alerted;
}
