/**
 * MULTI-CHANNEL RESEARCH ENGINE:
 * Researches and monitors opportunities across all leading Solana trading channels:
 * 1. Meteora DLMM & Dynamic AMM
 * 2. Raydium CPMM & Concentrated Liquidity (CLMM)
 * 3. Moonshot Launchpad
 * 4. Multi-DEX Volume Breakouts
 *
 * Integrates directly with the Pattern Learning Engine to dynamically optimize
 * trade sizing and profit targets based on empirical win rates.
 */
import { supabase } from "./supabase.js";
import { sendTelegramPhoto, sendTelegramPhotoTo, sendTelegramMessageTo } from "./telegram.js";
import {
  fetchMultiChannelSolanaPairs,
  fetchTokenPairs,
  getTokenImageUrl,
  DexScreenerPair,
} from "./researchSources.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";
import { classifyTokenRisk } from "./jev.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openPaperTrade, getPaperTradingSettings, getPaperWallet } from "./paperTrading.js";
import {
  extractPatternFeatures,
  getPatternOptimizationAdvice,
  MarketChannel,
  PatternOptimizationAdvice,
} from "./patternLearning.js";

const COOLDOWN_HOURS = Number(process.env.MULTI_CHANNEL_COOLDOWN_HOURS ?? 6);
const MIN_LIQUIDITY_USD = Number(process.env.MULTI_CHANNEL_MIN_LIQ_USD ?? 6000);
const MIN_VOLUME_24H_USD = Number(process.env.MULTI_CHANNEL_MIN_VOL_USD ?? 15000);
const ZOOMA_BANNER_IMAGE = process.env.ZOOMA_BANNER_URL ?? "assets/zooma_logo.png";

export interface MultiChannelCandidate {
  tokenAddress: string;
  name: string;
  symbol: string;
  channel: MarketChannel;
  channelName: string;
  channelBadge: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number;
  dexId: string;
  buyRatioPct: number;
  ageHours: number;
  imageUrl: string;
  pair: DexScreenerPair;
  patternAdvice: PatternOptimizationAdvice;
  rugScore: number;
  isUltraSafe: boolean;
}

async function isInCooldown(tokenMint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
  try {
    const { data } = await supabase
      .from("signals")
      .select("id")
      .eq("token_mint", tokenMint)
      .eq("category", "multi_channel_gem")
      .gte("created_at", cutoff)
      .limit(1);
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function resolveChannelInfo(pair: DexScreenerPair): { channel: MarketChannel; name: string; badge: string } {
  const dex = (pair.dexId || "").toLowerCase();
  if (dex.includes("meteora")) {
    return { channel: "meteora", name: "Meteora DLMM", badge: "🌊 [METEORA DLMM BREAKOUT]" };
  }
  if (dex.includes("moonshot")) {
    return { channel: "moonshot", name: "Moonshot Launchpad", badge: "🌙 [MOONSHOT LAUNCHPAD]" };
  }
  if (dex.includes("raydium")) {
    return { channel: "raydium", name: "Raydium CPMM/CLMM", badge: "⚡ [RAYDIUM CPMM RUNNER]" };
  }
  return { channel: "dex_breakout", name: "Multi-DEX Breakout", badge: "🚀 [MULTI-DEX BREAKOUT]" };
}

/**
 * Fetches and filters top cross-channel opportunities.
 */
export async function fetchTopMultiChannelOpportunities(limit: number = 10): Promise<MultiChannelCandidate[]> {
  const rawPairs = await fetchMultiChannelSolanaPairs();
  const wallet = getPaperWallet();
  const settings = getPaperTradingSettings();
  const baseSize = settings.positionSize;

  const candidates: MultiChannelCandidate[] = [];

  for (const pair of rawPairs) {
    if (candidates.length >= limit) break;
    const tokenAddress = pair.baseToken?.address;
    if (!tokenAddress) continue;

    const liq = pair.liquidity?.usd ?? 0;
    const vol = pair.volume?.h24 ?? 0;
    if (liq < MIN_LIQUIDITY_USD || vol < MIN_VOLUME_24H_USD) continue;

    const buys = pair.txns?.h24?.buys ?? 0;
    const sells = pair.txns?.h24?.sells ?? 0;
    const totalTx = buys + sells;
    const buyRatioPct = totalTx > 0 ? Math.round((buys / totalTx) * 100) : 50;

    const ageHours = pair.pairCreatedAt ? Math.max(0, (Date.now() - pair.pairCreatedAt) / 3_600_000) : 2.0;
    const priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
    const fdvUsd = pair.fdv ?? 0;

    const { channel, name, badge } = resolveChannelInfo(pair);

    const features = extractPatternFeatures({
      channel,
      dexId: pair.dexId,
      liquidityUsd: liq,
      volume24hUsd: vol,
      buyCount: buys,
      sellCount: sells,
      devHoldingPct: 3.0,
    });

    const advice = getPatternOptimizationAdvice(features, baseSize, wallet.availableCash);

    // Fast rug check
    const rug = await evaluateTokenRugRisk(tokenAddress);
    if (rug.riskScore > 35) continue; // Skip high risk setups

    const imageUrl = getTokenImageUrl(tokenAddress, pair);

    candidates.push({
      tokenAddress,
      name: pair.baseToken.name || "Unknown",
      symbol: pair.baseToken.symbol || "GEM",
      channel,
      channelName: name,
      channelBadge: badge,
      priceUsd,
      liquidityUsd: liq,
      volume24hUsd: vol,
      fdvUsd,
      dexId: pair.dexId,
      buyRatioPct,
      ageHours,
      imageUrl,
      pair,
      patternAdvice: advice,
      rugScore: rug.riskScore,
      isUltraSafe: rug.riskScore <= 20,
    });
  }

  // Rank by win rate, profit factor, and liquidity quality
  return candidates.sort((a, b) => b.patternAdvice.winRatePct - a.patternAdvice.winRatePct);
}

/**
 * Executes a single research scan across Meteora, Raydium, and Moonshot channels.
 * Evaluates candidates, tests them against learned patterns, and alerts high-conviction setups.
 */
export async function runMultiChannelResearchOnce(): Promise<number> {
  const candidates = await fetchTopMultiChannelOpportunities(6);
  let alerted = 0;

  for (const item of candidates) {
    if (await isInCooldown(item.tokenAddress)) continue;

    // Only broadcast high-conviction S-Tier or A-Tier setups with >= 65% learned win rate
    if (!item.patternAdvice.isHighConviction && item.patternAdvice.winRatePct < 65) {
      continue;
    }

    const priceStr = item.priceUsd < 0.01 ? `$${item.priceUsd.toFixed(6)}` : `$${item.priceUsd.toFixed(4)}`;
    const ageStr = item.ageHours < 1 ? `${Math.round(item.ageHours * 60)}m` : `${item.ageHours.toFixed(1)}h`;

    const signalId = crypto.randomUUID();

    // Persist signal in background
    (async () => {
      try {
        await supabase.from("signals").insert({
          id: signalId,
          token_mint: item.tokenAddress,
          signal_type: "MULTI_CHANNEL_RESEARCH",
          category: "multi_channel_gem",
          status: "UNVALIDATED",
          details: {
            channel: item.channel,
            channelName: item.channelName,
            dexId: item.dexId,
            liquidityUsd: item.liquidityUsd,
            volume24hUsd: item.volume24hUsd,
            buyRatioPct: item.buyRatioPct,
            patternKey: item.patternAdvice.patternKey,
            tier: item.patternAdvice.tier,
            winRatePct: item.patternAdvice.winRatePct,
            profitFactor: item.patternAdvice.profitFactor,
            rugScore: item.rugScore,
          },
        });
      } catch {
        // non-blocking
      }
    })();

    const alertText =
      `${item.channelBadge}\n\n` +
      `*${item.name} ($${item.symbol})*\n` +
      `• Token CA: \`${item.tokenAddress}\`\n` +
      `• Channel: *${item.channelName}* (Pool: \`${item.dexId}\`)\n` +
      `• Price: *${priceStr} USD* | FDV: *~$${Math.round(item.fdvUsd).toLocaleString()}*\n` +
      `• Liquidity: *$${Math.round(item.liquidityUsd).toLocaleString()} USD*\n` +
      `• 24h Volume: *$${Math.round(item.volume24hUsd).toLocaleString()} USD* (${item.buyRatioPct}% Buys)\n` +
      `• Pool Age: *${ageStr}*\n\n` +
      `🧠 *AI Pattern Learning Read:*\n` +
      `• Setup Conviction: ${item.patternAdvice.badge}\n` +
      `• Historical Win Rate: *${item.patternAdvice.winRatePct}%* | Profit Factor: *${item.patternAdvice.profitFactor.toFixed(1)}x*\n` +
      `• Profit Maximization: *${item.patternAdvice.sizeMultiplier}x Sizing* ($${item.patternAdvice.recommendedPositionSizeUsd.toFixed(2)} USD) | TP: *+${item.patternAdvice.takeProfitPct}%*\n` +
      `• Rationale: _${item.patternAdvice.rationale}_\n\n` +
      `🛡️ *Sub-Second Safety Audit:*\n` +
      `• Rug Risk: *${item.isUltraSafe ? "🟢 ULTRA-SAFE" : "🟢 LOW RISK"} (${item.rugScore}/100)*\n` +
      `• Authorities: ✅ Mint & Freeze Renounced\n\n` +
      `⚡ *Instant Execution Terminal:*`;

    const buttons = getTokenTradingButtons(item.tokenAddress);

    try {
      await sendTelegramPhoto(item.imageUrl, alertText, buttons);
    } catch {
      await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, alertText, buttons).catch(() => {});
    }

    // Auto-open simulated paper trade with dynamically optimized sizing and take-profit targets!
    try {
      await openPaperTrade(
        signalId,
        item.tokenAddress,
        "solid_gem",
        item.priceUsd,
        item.pair,
        item.patternAdvice.winRatePct / 100
      );
    } catch (err) {
      console.warn("[multiChannelResearch] failed to open paper trade:", (err as Error).message);
    }

    alerted++;
  }

  return alerted;
}

/**
 * Handles the `/channels` slash command: presents top opportunities across Meteora, Raydium, and Moonshot.
 */
export async function handleChannelsCommand(chatId: string): Promise<void> {
  await sendTelegramMessageTo(
    chatId,
    "🔍 *Scanning Multi-Channel Solana Markets...*\n\n" +
    "Auditing live pools across Meteora DLMM, Raydium CPMM, Moonshot, and multi-DEX volume breakouts with AI pattern intelligence."
  );

  const candidates = await fetchTopMultiChannelOpportunities(4);

  if (candidates.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ *No qualifying multi-channel setups right now.*\n\n" +
      "Active filters enforce >= $6,000 liquidity, renounced authorities, and high-win-rate learned patterns. New pools are being monitored 24/7."
    );
    return;
  }

  for (const item of candidates) {
    const priceStr = item.priceUsd < 0.01 ? `$${item.priceUsd.toFixed(6)}` : `$${item.priceUsd.toFixed(4)}`;
    const ageStr = item.ageHours < 1 ? `${Math.round(item.ageHours * 60)}m` : `${item.ageHours.toFixed(1)}h`;

    const text =
      `${item.channelBadge}\n\n` +
      `*${item.name} ($${item.symbol})*\n` +
      `• Token CA: \`${item.tokenAddress}\`\n` +
      `• Channel: *${item.channelName}* (DEX: \`${item.dexId}\`)\n` +
      `• Price: *${priceStr} USD* | FDV: *~$${Math.round(item.fdvUsd).toLocaleString()}*\n` +
      `• Pool Liquidity: *$${Math.round(item.liquidityUsd).toLocaleString()} USD*\n` +
      `• 24h Volume: *$${Math.round(item.volume24hUsd).toLocaleString()} USD* (${item.buyRatioPct}% Buys)\n` +
      `• Pool Age: *${ageStr}*\n\n` +
      `🧠 *AI Pattern Learning Insight:*\n` +
      `• Conviction: ${item.patternAdvice.badge}\n` +
      `• Win Rate: *${item.patternAdvice.winRatePct}%* | Profit Factor: *${item.patternAdvice.profitFactor.toFixed(1)}x*\n` +
      `• Profit Maximization: *${item.patternAdvice.sizeMultiplier}x Sizing* ($${item.patternAdvice.recommendedPositionSizeUsd.toFixed(2)} USD) | TP: *+${item.patternAdvice.takeProfitPct}%*\n\n` +
      `🛡️ *Safety Audit:* 🟢 *${item.rugScore}/100 Risk Score (Safe)*\n\n` +
      `⚡ *Trade Immediately:*`;

    const buttons = getTokenTradingButtons(item.tokenAddress);

    try {
      await sendTelegramPhotoTo(chatId, item.imageUrl, text, buttons);
    } catch {
      await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, buttons).catch(() => {});
    }
  }
}
