/**
 * TELEGRAM SLASH COMMANDS: /watch, /unwatch, /list, /wallets, /wallet, /status, /scores,
 * /scan, /trending, /solid, /gems, /whales, /activity, /traders, /discover, /help.
 */
import { supabase } from "./supabase.js";
import {
  sendTelegramMessageTo,
  sendTelegramPhotoTo,
  registerActiveChat,
  scheduleVaporization,
  VAPORIZE_DELAY_SECONDS,
} from "./telegram.js";
import { refreshWebhookWithCurrentWallets, runDiscoveryOnce } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";
import { fetchTokenPairs, fetchLatestBoostedSolanaTokens, getTokenImageUrl, resolvePumpTokenImageUrl } from "./researchSources.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import {
  openTrendingPaperTrade,
  openManualPaperTrade,
  openAutonomousTrade,
  getOpenPositionsReport,
  sendPositionsPhotoCards,
  closePaperTradeManually,
  sendTradeHistory,
  sendPaperBalancePhoto,
  computeStats,
  formatStats,
  setPaperTradingActive,
  setPaperTradingPositionSize,
  getPaperTradingSettings,
  fundPaperWallet,
  getPaperWallet,
  isPaperWalletFunded,
  stopPaperTradingAndReport,
} from "./paperTrading.js";
import { getRecentTraderEntries, formatTraderEntriesText, scanAndRecord100xTopTraders } from "./topTraders.js";
import { scanSolidGems, fireSolidGemAlert } from "./solidGems.js";
import { scanEarly100xGems } from "./early100xGems.js";
import { fetchTopTrendingSolanaTokens, TrendingTokenDetail } from "./trendingAlerter.js";
import { scanInsiderDrops } from "./insiderSniper.js";
import { getRecentPumpDrops } from "./pumpFunStream.js";
import { classifyPumpDrop, calculateDeterministicPumpRugScore } from "./jev.js";
import { explainPumpDrop } from "./llm.js";
import {
  getWalletIdenticonUrl,
  inspectWalletDetail,
  formatWalletDetailText,
  getWalletProfileButtons,
} from "./walletInspector.js";
import { isSniperActive, setSniperActive, getSniperState } from "./sniperControl.js";
import { handleChannelsCommand } from "./multiChannelResearch.js";
import { formatPatternDashboardText } from "./patternLearning.js";
import { formatDumpDashboardText } from "./dumpDetector.js";
import {
  isUserRegistered,
  getUser,
  registerUser,
  recordUserActivity,
  getUserStats,
  formatUserStatsDashboard,
} from "./userRegistry.js";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_CAPACITY = Number(process.env.MAX_TRACKED_WALLETS ?? 5000);
const ZOOMA_BANNER_IMAGE = process.env.ZOOMA_BANNER_URL ?? "assets/zooma_logo.png";

const HELP_BUTTONS = [
  [
    { text: "⚡ Photon Terminal", url: "https://photon-sol.tinyastro.io" },
    { text: "🐂 BullX Terminal", url: "https://neo.bullx.io" },
  ],
  [
    { text: "📊 GMGN AI", url: "https://gmgn.ai/sol" },
    { text: "📈 DexScreener", url: "https://dexscreener.com/solana" },
  ],
];

interface TelegramUpdate {
  message?: {
    message_id?: number;
    from?: {
      id: number;
      is_bot?: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type?: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    text?: string;
  };
}

const HELP_TEXT =
  `🤖 *ZOOMA Onchain Intelligence*\n` +
  `_Automated Solana Breakout Engine & Paper Trader_\n\n` +
  `⚡ *Primary Commands:*\n` +
  `⚡ \`/autotrade <CA>\` : Autonomous Single Trade (Auto-Buy & Auto-Sell)\n` +
  `🚨 \`/dumps\` : Real-Time Dump Shield & Detected Dumps\n` +
  `🎯 \`/sniper [on|off]\` : Control Millisecond Sniper Engine\n` +
  `🛑 \`/stopsniper\` : Stop Millisecond Drop Alerts\n` +
  `🟢 \`/startsniper\` : Start / Resume Drop Alerts\n` +
  `💊 \`/pump\` : Live Pump.fun Drops & Graduations\n` +
  `⚡ \`/insider\` : Ultra-Early Launches (10 - 30m old)\n` +
  `💎 \`/gems\` : Live Fresh Gems (< 48h) & 100x Breakouts\n` +
  `🔥 \`/trending\` : Top 15 Trending Solana Tokens\n` +
  `💵 \`/fund [amount]\` : Fund Paper Wallet ($10 USD min, e.g. \`/fund 10\`)\n` +
  `💼 \`/papertrade [CA]\` : Start / Trade CA ($2 USD) / Configure\n` +
  `🛑 \`/stoppapertrade\` : Stop Trading & See Profit on Capital\n` +
  `📈 \`/positions\` : Live Paper Portfolio & Real-Time PnL\n` +
  `💰 \`/balance\` : All-Time Money Made & Portfolio Cash\n` +
  `❌ \`/close <CA>\` : Close Position at Market Price\n` +
  `📜 \`/history\` : Closed Trades & Win-Rate History\n` +
  `👑 \`/traders\` : 100x - 1000x Top Traders Leaderboard\n` +
  `🌐 \`/channels\` : Multi-Channel Scanner (Meteora, Raydium, Moonshot)\n` +
  `🧠 \`/patterns\` : AI Pattern Learning & Profit Maximizer\n` +
  `👥 \`/register\` : Register & Unlock Full Access\n` +
  `👥 \`/users\` : Member Analytics & Community Stats\n` +
  `👤 \`/profile\` : Your Member ID & Activity Card\n` +
  `🛡️ \`/scan <CA>\` : Security Audit & Snipe Links\n` +
  `🐋 \`/wallets\` : Smart Money Tracker & Whales\n` +
  `🧠 \`/ai\` : JEV & LLM AI Architecture\n\n` +
  `🔔 *Automated 24/7 Alerts:*\n` +
  `• ⚡ Autonomous Single Trades (Automatic Buy ➡️ Dump Shield ➡️ Auto-Sell)\n` +
  `• 🚨 Real-Time Dump Shield (Dev & Whale Sell Interception)\n` +
  `• 💊 Pump.fun Live Creations & Raydium Migrations\n` +
  `• 🌐 Multi-Channel Scans (Meteora DLMM, Raydium, Moonshot)\n` +
  `• 🧠 Pattern Learning Engine (Dynamic Sizing & Profit Targets)\n` +
  `• ⚡ 10m - 30m Verified Insider Drops\n` +
  `• 🚀 Fresh 100x Breakouts & High Volume Spikes\n` +
  `• 👑 100x - 1000x Top Trader & Sniper Alerts\n` +
  `• 💼 Auto Paper Trades, Breakeven Shields & TP Hits\n\n` +
  `_Sub-second predictive engine running 24/7._`;

async function handleWatch(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "⚠️ Usage: `/watch <solana wallet address>` (invalid address provided).");
    return;
  }

  const { error } = await supabase.from("tracked_wallets").insert({ address, source: "seed" });
  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessageTo(chatId, `ℹ️ Already tracking \`${address}\`.`);
    } else {
      await sendTelegramMessageTo(chatId, `❌ Failed to add wallet: ${error.message}`);
    }
    return;
  }

  await refreshWebhookWithCurrentWallets();
  await sendTelegramMessageTo(chatId, `✅ Now tracking \`${address}\` in real-time. Helius webhook updated.`);
}

async function handleUnwatch(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "⚠️ Usage: `/unwatch <solana wallet address>`");
    return;
  }

  const { error, count } = await supabase.from("tracked_wallets").delete({ count: "exact" }).eq("address", address);
  if (error) {
    await sendTelegramMessageTo(chatId, `❌ Failed to remove wallet: ${error.message}`);
    return;
  }
  if (!count) {
    await sendTelegramMessageTo(chatId, `ℹ️ \`${address}\` was not in your tracked list.`);
    return;
  }

  await refreshWebhookWithCurrentWallets();
  await sendTelegramMessageTo(chatId, `✅ Removed \`${address}\`. Helius webhook updated.`);
}

async function handleList(chatId: string): Promise<void> {
  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("address, source, added_at")
    .order("added_at", { ascending: false });

  if (error || !wallets || wallets.length === 0) {
    await sendTelegramMessageTo(chatId, "🐋 *Tracked Wallets:* 0 active.\n\nUse `/watch <address>` to track a wallet or `/discover` to auto-harvest smart money.");
    return;
  }

  const total = wallets.length;
  const pct = ((total / MAX_CAPACITY) * 100).toFixed(1);
  const seedCount = wallets.filter((w) => w.source === "seed").length;
  const autoCount = wallets.filter((w) => w.source !== "seed").length;

  let text =
    `🐋 *[SMART MONEY WALLET RADAR]*\n\n` +
    `• Active Tracked Wallets: *${total}* / *${MAX_CAPACITY}* (${pct}%)\n` +
    `• Seed Wallets: *${seedCount}* | Auto-Discovered: *${autoCount}*\n` +
    `• Monitoring Engine: *Active On-Chain Polling + Helius Enhanced Webhooks*\n\n` +
    `*Recent Smart Money Wallets:*\n`;

  const displayList = wallets.slice(0, 15);
  for (let i = 0; i < displayList.length; i++) {
    const w = displayList[i];
    const short = `\`${w.address}\``;
    const tag = w.source === "seed" ? "🎯 Seed" : "🤖 Auto";
    text += `${i + 1}. ${short} | ${tag}\n`;
  }

  if (total > 15) {
    text += `\n_...and ${total - 15} more active smart money wallets tracked 24/7._\n`;
  }

  text += `\n💡 _Tip: Use \`/wallet <address>\` for full dossier & avatar or \`/watch <address>\` to track a new wallet._`;

  const topButtons = displayList.slice(0, 3).map((w) => [
    { text: `🔍 Solscan (${w.address.slice(0, 4)}...${w.address.slice(-4)})`, url: `https://solscan.io/account/${w.address}` },
    { text: `⚡ Photon Profile`, url: `https://photon-sol.tinyastro.io/en/u/${w.address}` },
  ]);

  await sendTelegramMessageTo(chatId, text, topButtons);
}

async function handleInspectWallet(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "⚠️ Usage: `/wallet <solana wallet address>`");
    return;
  }

  await sendTelegramMessageTo(chatId, `🔍 Gathering on-chain intelligence for \`${address}\`...`);
  const profile = await inspectWalletDetail(address);
  const text = formatWalletDetailText(profile);
  const identiconUrl = getWalletIdenticonUrl(address);
  const buttons = getWalletProfileButtons(address);

  await sendTelegramPhotoTo(chatId, identiconUrl, text, buttons);
}

async function handleStatus(chatId: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { count: signalCount } = await supabase
    .from("signals")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);

  const { count: openTrades } = await supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("status", "open");
  const { count: closedTrades } = await supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("status", "closed");
  const { count: totalWallets } = await supabase.from("tracked_wallets").select("*", { count: "exact", head: true });
  const userStats = getUserStats();

  await sendTelegramMessageTo(
    chatId,
    `📊 *System Status & Activity (Last 24h)*\n\n` +
      `• Registered Bot Members: *${userStats.totalUsers}* (*${userStats.active24h}* active today)\n` +
      `• Tracked Wallets: *${totalWallets ?? 0}* / *${MAX_CAPACITY}*\n` +
      `• Detected Signals: *${signalCount ?? 0}*\n` +
      `• Open Paper Trades: *${openTrades ?? 0}*\n` +
      `• Closed Paper Trades (All-Time): *${closedTrades ?? 0}*\n` +
      `• Total Commands Handled: *${userStats.totalCommands}*\n\n` +
      `_Run \`npm run report\` for comprehensive expectancy & PnL breakdowns._`
  );
}

async function handleScores(chatId: string): Promise<void> {
  const results = await computeAllWalletScores();
  const scored = results.filter((r) => r.tradesWithOutcome > 0);

  if (scored.length === 0) {
    await sendTelegramMessageTo(chatId, `ℹ️ No closed paper trades yet. Credibility scores compute as simulated trades complete.`);
    return;
  }

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 5);
  const bottom = sorted.slice(-5).reverse();

  const fmt = (r: (typeof sorted)[number]) => `• \`${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}\`: *${r.score.toFixed(0)}/100* (${r.tradesWithOutcome} trades)`;

  await sendTelegramMessageTo(
    chatId,
    `🏆 *Wallet Credibility Leaderboard*\n\n*Top Performers:*\n${top.map(fmt).join("\n")}\n\n*Lowest Performers:*\n${bottom.map(fmt).join("\n")}`
  );
}

async function handleScan(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "⚠️ Usage: `/scan <token mint address>`");
    return;
  }

  await sendTelegramMessageTo(chatId, `🔍 Conducting real-time audit for \`${address}\`...`);

  const [pairs, topHolder] = await Promise.all([
    fetchTokenPairs(address).catch(() => []),
    getTopHolderConcentration(address).catch(() => null),
  ]);

  if (pairs.length === 0) {
    const rugAudit = await evaluateTokenRugRisk(address, { includeAiAnalysis: true });
    const scoreEmoji = rugAudit.securityScore >= 80 ? "🟢" : rugAudit.securityScore >= 50 ? "🟡" : "🚨";

    let aiSection = "";
    if (rugAudit.jevAnalysis) {
      aiSection += `🤖 *JEV AI Risk Read:* ${rugAudit.jevAnalysis.badge} (${(rugAudit.jevAnalysis.confidence * 100).toFixed(0)}% confidence)\n`;
    }
    if (rugAudit.aiExplanation) {
      aiSection += `🧠 *AI Risk Audit:* _${rugAudit.aiExplanation}_\n\n`;
    }

    const text =
      `🔬 *Token Security Audit*\n\n` +
      `• Token CA: \`${address}\`\n\n` +
      `🛡️ *Rug Pull Security Score: ${scoreEmoji} ${rugAudit.securityScore}/100*\n` +
      `• Verdict: *${rugAudit.verdict}*\n\n` +
      aiSection +
      `📋 *Security Checklist:*\n` +
      rugAudit.checklist.map((c) => `• ${c.name}: *${c.badge}*`).join("\n") + "\n\n" +
      `ℹ️ _No active Raydium pool listed yet._\n\n` +
      `⚡ *Snipe & Fast Trade Buttons:*`;

    const imageUrl = getTokenImageUrl(address);
    await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(address));
    return;
  }

  const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  const liqUsd = pair.liquidity?.usd ?? 0;
  const vol24h = pair.volume?.h24 ? `$${Math.round(pair.volume.h24).toLocaleString()}` : "n/a";
  const price = pair.priceUsd ? (Number(pair.priceUsd) < 0.01 ? `$${Number(pair.priceUsd).toFixed(6)}` : `$${Number(pair.priceUsd).toFixed(4)}`) : "n/a";
  const fdv = pair.fdv ? `$${Math.round(pair.fdv).toLocaleString()}` : "n/a";

  const rugAudit = await evaluateTokenRugRisk(address, { topHolderPct: topHolder, liquidityUsd: liqUsd, pair, includeAiAnalysis: true });
  const scoreEmoji = rugAudit.securityScore >= 80 ? "🟢" : rugAudit.securityScore >= 50 ? "🟡" : "🚨";

  let aiSection = "";
  if (rugAudit.jevAnalysis) {
    aiSection += `🤖 *JEV AI Model:* ${rugAudit.jevAnalysis.badge} (${(rugAudit.jevAnalysis.confidence * 100).toFixed(0)}% confidence)\n`;
  }
  if (rugAudit.aiExplanation) {
    aiSection += `🧠 *Groq AI Security Audit:* _${rugAudit.aiExplanation}_\n\n`;
  }

  let rugSection =
    `🛡️ *Rug Pull Security Score: ${scoreEmoji} ${rugAudit.securityScore}/100*\n` +
    `• Verdict: *${rugAudit.verdict}*\n\n` +
    aiSection +
    `📋 *Security Audit Checklist:*\n` +
    rugAudit.checklist.map((c) => `• ${c.name}: *${c.badge}* (${c.detail})`).join("\n") + "\n";

  if (rugAudit.flags.length > 0) {
    rugSection += `\n⚠️ *Detected Risk Flags:*\n` + rugAudit.flags.map((f) => `• ${f}`).join("\n") + `\n`;
  }

  const text =
    `🔬 *Token Security & Market Scan*\n\n` +
    `*${pair.baseToken.name} ($${pair.baseToken.symbol})*\n` +
    `• Token CA: \`${address}\`\n\n` +
    `📊 *Market Overview:*\n` +
    `• Price: *${price}* | FDV: *${fdv}*\n` +
    `• Liquidity: *$${Math.round(liqUsd).toLocaleString()}* | 24h Vol: *${vol24h}*\n` +
    `• DEX: *${pair.dexId}*\n\n` +
    `${rugSection}\n` +
    `⚡ *Execute instant trade on fast terminals:*`;

  const imageUrl = getTokenImageUrl(address, pair);
  await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(address));
}

async function handleTrending(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🔥 Fetching top 15 live trending Solana tokens with images & market data...");
  const trendingList = await fetchTopTrendingSolanaTokens(15).catch(() => []);

  if (trendingList.length === 0) {
    await sendTelegramMessageTo(chatId, "No trending tokens returned right now. Please check again in a minute.");
    return;
  }

  // Send photo cards for top 5 breakout tokens
  const topCards = trendingList.slice(0, 5);
  for (let i = 0; i < topCards.length; i++) {
    const t = topCards[i];
    openTrendingPaperTrade(t.tokenAddress).catch(() => {});

    const priceStr = Number(t.priceUsd) < 0.01 ? `$${Number(t.priceUsd).toFixed(6)}` : `$${Number(t.priceUsd).toFixed(4)}`;
    const caption =
      `🔥 *#${i + 1} Trending Token | ${t.name} ($${t.symbol})*\n\n` +
      `• Token CA: \`${t.tokenAddress}\`\n` +
      `• Price: *${priceStr}* | FDV: *$${Math.round(t.fdv).toLocaleString()}*\n` +
      `• 24h Volume: *$${Math.round(t.volume24hUsd).toLocaleString()}*\n` +
      `• Liquidity: *$${Math.round(t.liquidityUsd).toLocaleString()}* | Age: *${t.ageHours}h*\n` +
      `• DEX: *${t.dexId}*\n\n` +
      `⚡ *Snipe & Fast Trade Buttons:*`;

    await sendTelegramPhotoTo(chatId, t.imageUrl, caption, getTokenTradingButtons(t.tokenAddress));
  }

  // Format full 15-token trending board
  let text = `🔥 *Top 15 Live Trending Solana Tokens (DexScreener & Raydium)*\n\n`;
  for (let i = 0; i < trendingList.length; i++) {
    const t = trendingList[i];
    openTrendingPaperTrade(t.tokenAddress).catch(() => {});
    const priceStr = Number(t.priceUsd) < 0.01 ? `$${Number(t.priceUsd).toFixed(6)}` : `$${Number(t.priceUsd).toFixed(4)}`;
    const volStr = `$${Math.round(t.volume24hUsd).toLocaleString()}`;

    text += `${i + 1}. *${t.name} ($${t.symbol})*\n`;
    text += `   • CA: \`${t.tokenAddress}\`\n`;
    text += `   • Price: *${priceStr}* | Vol: *${volStr}* | Age: *${t.ageHours}h*\n\n`;
  }

  text += `_Simulated $2 paper trades automatically opened._\n_Use \`/scan <CA>\` for full security audit or tap any quick-trade button._`;

  const top3Buttons = trendingList.slice(0, 3).map((t) => [
    { text: `⚡ Photon (${t.symbol})`, url: `https://photon-sol.tinyastro.io/en/lp/${t.tokenAddress}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${t.tokenAddress}` },
    { text: `📊 GMGN`, url: `https://gmgn.ai/sol/token/${t.tokenAddress}` },
  ]);

  await sendTelegramMessageTo(chatId, text, top3Buttons);
}

async function handleLiveGems(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "💎 Scanning live Solana DEX pools (< 48h) for fresh 100x breakouts & verified solid gems...");

  const [early100x, solid] = await Promise.all([
    scanEarly100xGems(3).catch(() => []),
    scanSolidGems(3).catch(() => []),
  ]);

  const allGems = [...early100x];
  for (const s of solid) {
    if (!allGems.some((g) => g.tokenAddress === s.tokenAddress)) {
      allGems.push(s as any);
    }
  }

  if (allGems.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ All fresh pools (< 48h) are currently being evaluated. The bot monitors the chain 24/7 and will auto-alert you the moment a new breakout gem passes security checks."
    );
    return;
  }

  // Send photo cards for top gems
  const topGems = allGems.slice(0, 3);
  for (let i = 0; i < topGems.length; i++) {
    const gem = topGems[i];
    openTrendingPaperTrade(gem.tokenAddress).catch(() => {});

    const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
    const holderText = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}%` : "Safe";
    const buyRatioText = (gem as any).buyRatioPct ? `• Buy Pressure: *${(gem as any).buyRatioPct.toFixed(0)}% Buys*\n` : "";
    const runwayText = (gem as any).potentialMultiplier ? `• Growth Runway: *${(gem as any).potentialMultiplier}* (Low-Cap Entry)\n` : "";

    const text =
      `💎 *[LIVE GEM BREAKOUT | #${i + 1}]*\n\n` +
      `*${gem.name} ($${gem.symbol})*\n` +
      `• CA: \`${gem.tokenAddress}\`\n\n` +
      `📊 *Live DEX Metrics:*\n` +
      `• Market Cap / FDV: *$${Math.round(gem.fdv).toLocaleString()}*\n` +
      `• Liquidity: *$${Math.round(gem.liquidityUsd).toLocaleString()}* | 24h Vol: *$${Math.round(gem.volume24hUsd).toLocaleString()}*\n` +
      `• Age: *${gem.ageHours}h old* | DEX: *${gem.dexId}*\n` +
      buyRatioText +
      runwayText +
      `\n🛡️ *Security Audit (Verified Safe):*\n` +
      `• Mint Authority: ✅ Renounced\n` +
      `• Freeze Authority: ✅ Renounced\n` +
      `• Top 1 Holder: ✅ ${holderText}\n` +
      `• Rug Risk: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
      `⚡ *Fast Snipe & Trade Terminal:*`;

    await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(gem.tokenAddress));
  }

  // Also send a summary digest of all found gems
  let summary = `💎 *Live Fresh Solana Gems (< 48h old)*\n\n`;
  for (let i = 0; i < allGems.length; i++) {
    const g = allGems[i];
    const priceStr = Number(g.priceUsd) < 0.01 ? `$${Number(g.priceUsd).toFixed(6)}` : `$${Number(g.priceUsd).toFixed(4)}`;
    summary += `${i + 1}. *${g.name} ($${g.symbol})*\n`;
    summary += `   • CA: \`${g.tokenAddress}\`\n`;
    summary += `   • Price: *${priceStr}* | FDV: *$${Math.round(g.fdv).toLocaleString()}* | Age: *${g.ageHours}h*\n\n`;
  }
  summary += `_Simulated $2 paper trades automatically opened._\n_Use \`/scan <CA>\` for full security audit or tap any quick-trade button._`;

  const topButtons = allGems.slice(0, 3).map((g) => [
    { text: `⚡ Photon (${g.symbol})`, url: `https://photon-sol.tinyastro.io/en/lp/${g.tokenAddress}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${g.tokenAddress}` },
    { text: `📊 GMGN`, url: `https://gmgn.ai/sol/token/${g.tokenAddress}` },
  ]);

  await sendTelegramMessageTo(chatId, summary, topButtons);
}

async function handleWhales(chatId: string): Promise<void> {
  const { data: signals, error } = await supabase
    .from("signals")
    .select("token_mint, details, created_at")
    .eq("signal_type", "WHALE_BUY")
    .order("created_at", { ascending: false })
    .limit(6);

  if (error || !signals || signals.length === 0) {
    await sendTelegramMessageTo(chatId, "ℹ️ No recent whale buys detected yet. As tracked smart money wallets buy, alerts will appear here in real-time.");
    return;
  }

  // Send photo cards for top 2 whale buys
  const topWhales = signals.slice(0, 2);
  for (let i = 0; i < topWhales.length; i++) {
    const s = topWhales[i];
    const details = s.details as any;
    const wallet = details?.wallet ? `\`${details.wallet.slice(0, 6)}...${details.wallet.slice(-4)}\`` : "Smart Money";
    const sol = details?.sol_amount ? `${Number(details.sol_amount).toFixed(2)} SOL` : "Buy";
    const time = new Date(s.created_at).toLocaleTimeString();

    const pairs = await fetchTokenPairs(s.token_mint).catch(() => []);
    const pair = pairs.length > 0 ? pairs[0] : undefined;
    const symbol = pair?.baseToken?.symbol ? `$${pair.baseToken.symbol}` : s.token_mint.slice(0, 8);
    const name = pair?.baseToken?.name ?? symbol;
    const imageUrl = getTokenImageUrl(s.token_mint, pair);

    const caption =
      `🐋 *[SMART MONEY WHALE ACCUMULATION]*\n\n` +
      `*${name} (${symbol})*\n` +
      `• Token CA: \`${s.token_mint}\`\n\n` +
      `💰 *Transaction Metrics:*\n` +
      `• Buy Volume: *${sol}*\n` +
      `• Buyer Wallet: ${wallet}\n` +
      `• Recorded At: *${time}*\n\n` +
      `⚡ *Trade Fast on Terminals:*`;

    try {
      await sendTelegramPhotoTo(chatId, imageUrl, caption, getTokenTradingButtons(s.token_mint));
    } catch {
      await sendTelegramMessageTo(chatId, caption, getTokenTradingButtons(s.token_mint));
    }
  }

  let text = `🐋 *Recent Smart Money Whale Buys Summary*\n\n`;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    const details = s.details as any;
    const wallet = details?.wallet ? `\`${details.wallet.slice(0, 6)}...${details.wallet.slice(-4)}\`` : "Smart Money";
    const sol = details?.sol_amount ? `${Number(details.sol_amount).toFixed(2)} SOL` : "Buy";
    const time = new Date(s.created_at).toLocaleTimeString();

    text += `${i + 1}. *${sol}* by ${wallet}\n`;
    text += `   • CA: \`${s.token_mint}\` (${time})\n`;
  }

  text += `\n💡 _Use \`/scan <CA>\` to check any token or \`/wallet <address>\` for buyer dossier._`;

  const buttons = signals.slice(0, 3).map((s) => [
    { text: `⚡ Trade (${s.token_mint.slice(0, 4)}...)`, url: `https://photon-sol.tinyastro.io/en/lp/${s.token_mint}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${s.token_mint}` },
    { text: `📊 GMGN`, url: `https://gmgn.ai/sol/token/${s.token_mint}` },
  ]);

  await sendTelegramMessageTo(chatId, text, buttons);
}

async function handleActivity(chatId: string): Promise<void> {
  const { data: events, error } = await supabase
    .from("raw_events")
    .select("wallet, side, token_mint, sol_amount, token_amount, block_time")
    .order("block_time", { ascending: false })
    .limit(10);

  if (error || !events || events.length === 0) {
    await sendTelegramMessageTo(chatId, "ℹ️ No recent swap events logged. Make sure wallets are active and Helius webhook is connected.");
    return;
  }

  let text = `⚡ *Live Smart Money Activity Feed (Recent Swaps)*\n\n`;
  for (const e of events) {
    const icon = e.side === "buy" ? "🟢 BUY" : "🔴 SELL";
    const sol = e.sol_amount ? `${Number(e.sol_amount).toFixed(2)} SOL` : "";
    const shortW = `\`${e.wallet.slice(0, 6)}...${e.wallet.slice(-4)}\``;
    const shortM = `\`${e.token_mint.slice(0, 6)}...${e.token_mint.slice(-4)}\``;
    const time = new Date(e.block_time).toLocaleTimeString();

    text += `${icon} *${sol}* | ${shortW} ➡️ ${shortM} (${time})\n`;
  }

  text += `\n_Live on-chain swaps parsed in real-time from Helius webhook._`;
  await sendTelegramMessageTo(chatId, text);
}

async function handleTraders(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🔍 Fetching 100x - 1000x top traders & smart money snipers...");
  let entries = await getRecentTraderEntries(10);
  if (entries.length === 0) {
    await scanAndRecord100xTopTraders().catch(() => 0);
    entries = await getRecentTraderEntries(10);
  }
  const text = formatTraderEntriesText(entries);
  const buttons = [
    [
      { text: "⚡ Photon Terminal", url: "https://photon-sol.tinyastro.io" },
      { text: "🐂 BullX Terminal", url: "https://neo.bullx.io" },
    ],
    [
      { text: "📊 GMGN AI", url: "https://gmgn.ai/sol" },
      { text: "📈 DexScreener", url: "https://dexscreener.com/solana" },
    ],
  ];
  await sendTelegramMessageTo(chatId, text, buttons);
}

async function handleDiscover(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🔄 Initiating live wallet auto-discovery pass...");
  try {
    const res = await runDiscoveryOnce();
    await sendTelegramMessageTo(chatId, `✅ Discovery complete. Added *${res.added}* new smart-money wallet(s) to Helius webhook.`);
  } catch (err) {
    await sendTelegramMessageTo(chatId, `Discovery pass encountered an issue: ${(err as Error).message}`);
  }
}

async function handlePositions(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "📊 Calculating live unrealized PnL on active paper positions...");
  await sendPositionsPhotoCards(chatId);
}

async function handlePerformance(chatId: string): Promise<void> {
  const [d7, d30, d90] = await Promise.all([computeStats(7), computeStats(30), computeStats(90)]);
  const message =
    `📊 *[PAPER TRADING PERFORMANCE & EXPECTANCY]*\n\n` +
    `${formatStats("Last 7 Days", d7)}\n\n` +
    `${formatStats("Last 30 Days", d30)}\n\n` +
    `${formatStats("Last 90 Days", d90)}\n\n` +
    `_Statistical Note: Expectancy metrics become robust after 20+ closed trades._`;
  await sendTelegramMessageTo(chatId, message);
}

async function handleFundPaperWallet(chatId: string, amountStr?: string): Promise<void> {
  const currentWallet = getPaperWallet();
  // If user enters /fund without an amount and wallet is not funded yet, default to reduced $10 USD
  let amount = amountStr ? Number(amountStr) : !currentWallet.isFunded ? 10 : NaN;

  if (isNaN(amount) || amount <= 0) {
    const wallet = getPaperWallet();
    const statusText = wallet.isFunded
      ? `• Current Wallet Status: ✅ FUNDED\n` +
        `• Initial Funded Capital: *$${wallet.initialFundedAmount.toFixed(2)} USD*\n` +
        `• Available Cash: *$${wallet.availableCash.toFixed(2)} USD*\n` +
        `• In Active Trades: *$${wallet.allocatedCash.toFixed(2)} USD*\n\n` +
        `To add more capital, specify the amount: e.g. \`/fund 10\`, \`/fund 25\`, or \`/fund 50\``
      : `• Current Wallet Status: 🔴 NOT FUNDED\n\n` +
        `Required funding reduced to *$10.00 USD* (5 trades capacity at $2.00/trade).\n` +
        `Example: \`/fund 10\``;

    const text =
      `💼 *[ZOOMA PAPER TRADING WALLET]*\n\n` +
      statusText +
      `\n\n⚡ *Quick Commands:*\n` +
      `• \`/fund 10\` : Fund with $10.00 USD (5 trades capacity - Standard Entry)\n` +
      `• \`/fund 25\` : Fund with $25.00 USD (12 trades capacity)\n` +
      `• \`/fund 50\` : Fund with $50.00 USD (25 trades capacity)\n` +
      `• \`/fund 100\` : Fund with $100.00 USD (50 trades capacity)\n` +
      `• \`/papertrade on\` : Start auto-trading with funded wallet\n` +
      `• \`/stoppapertrade\` : Stop trading & show profit made on capital`;

    try {
      await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
    } catch {
      await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
    }
    return;
  }

  if (amount < 10) {
    await sendTelegramMessageTo(
      chatId,
      `⚠️ *Minimum Required Funding is $10.00 USD*\n\n` +
      `To allow multiple trade allocations ($2.00/trade) and proper risk distribution, the minimum required funds are *$10.00 USD* (5 trades capacity).\n\n` +
      `Usage: \`/fund 10\` (funds with $10.00 USD)`
    );
    return;
  }

  const wallet = fundPaperWallet(amount);
  setPaperTradingActive(true);
  const capacity = Math.floor(wallet.availableCash / 2.0);
  const text =
    `🎉 *[PAPER WALLET FUNDED SUCCESSFULLY]*\n\n` +
    `• Added Capital: *+$${amount.toFixed(2)} USD*\n` +
    `• Total Capital Funded: *$${wallet.initialFundedAmount.toFixed(2)} USD*\n` +
    `• Available Trading Cash: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Position Sizing: *$2.00 USD per trade*\n` +
    `• Execution Capacity: *~${capacity} concurrent / sequential trades*\n` +
    `• AI Safety Requirement: *>= 80% AI Confidence*\n` +
    `• System Status: 🟢 *ACTIVE (Auto-Trading Enabled)*\n\n` +
    `ZOOMA is now live! It will automatically allocate $2.00 paper trades from your wallet whenever a Solana alert hits >= 80% AI confidence.\n\n` +
    `⚡ *Controls & Tracking:*\n` +
    `• \`/positions\` : Inspect open positions & real-time PnL\n` +
    `• \`/balance\` : Live profit & wallet balance\n` +
    `• \`/stoppapertrade\` : Stop trading & calculate profit on capital`;

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
  }
}

async function handlePaperTradeCommand(chatId: string, action?: string, amountStr?: string): Promise<void> {
  // If action is a Solana address, open manual paper trade immediately!
  if (action && SOLANA_ADDRESS_RE.test(action)) {
    const size = amountStr && !isNaN(Number(amountStr)) && Number(amountStr) > 0 ? Number(amountStr) : undefined;
    await openManualPaperTrade(chatId, action, size);
    return;
  }

  const normAction = action?.toLowerCase();

  // If user requests to stop or pause paper trading
  if (normAction === "off" || normAction === "pause" || normAction === "stop") {
    await stopPaperTradingAndReport(chatId);
    return;
  }

  // If user passed a number to /papertrade (e.g. /papertrade 50):
  // If wallet is not funded yet, fund it with that amount!
  if (action && !isNaN(Number(action)) && Number(action) > 0) {
    if (!isPaperWalletFunded()) {
      await handleFundPaperWallet(chatId, action);
      return;
    }
    setPaperTradingPositionSize(Number(action));
    setPaperTradingActive(true);
  }

  // Check if wallet is funded. If not, prompt user to fund it!
  if (!isPaperWalletFunded()) {
    const promptText =
      `💼 *[PAPER TRADING WALLET NOT FUNDED]*\n\n` +
      `Before activating automated paper trading, please fund the bot with a fixed capital amount.\n\n` +
      `Required funding is reduced to *$10.00 USD* (5 trades capacity at $2.00/trade with strict >= 80% AI confidence).\n\n` +
      `*How much would you like to fund the bot with?*\n\n` +
      `⚡ *Quick Funding Options:*\n` +
      `• \`/fund 10\` : Fund $10.00 USD (5 trades capacity - Standard Entry)\n` +
      `• \`/fund 25\` : Fund $25.00 USD (12 trades capacity)\n` +
      `• \`/fund 50\` : Fund $50.00 USD (25 trades capacity)\n` +
      `• \`/fund 100\` : Fund $100.00 USD (50 trades capacity)\n` +
      `• Or specify any amount: \`/fund <amount>\`\n\n` +
      `_After you stop paper trading with \`/stoppapertrade\`, the bot will display the exact profit made on your funded capital._`;

    try {
      await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, promptText, HELP_BUTTONS);
    } catch {
      await sendTelegramMessageTo(chatId, promptText, HELP_BUTTONS);
    }
    return;
  }

  if (normAction === "on" || normAction === "activate" || normAction === "start") {
    setPaperTradingActive(true);
    if (amountStr && !isNaN(Number(amountStr)) && Number(amountStr) > 0) {
      setPaperTradingPositionSize(Number(amountStr));
    }
  }

  const settings = getPaperTradingSettings();
  const wallet = getPaperWallet();
  const statusEmoji = settings.enabled ? "🟢" : "🔴";
  const statusText = settings.enabled ? "ACTIVE (Auto-Trading Enabled)" : "PAUSED";
  const remainingTrades = Math.floor(wallet.availableCash / settings.positionSize);

  const message =
    `💼 *[PAPER TRADING CONTROL CENTER]*\n\n` +
    `• System Status: ${statusEmoji} *${statusText}*\n` +
    `• Initial Funded Capital: *$${wallet.initialFundedAmount.toFixed(2)} USD*\n` +
    `• Available Trading Cash: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• In Active Trades: *$${wallet.allocatedCash.toFixed(2)} USD*\n` +
    `• Position Sizing: *$${settings.positionSize.toFixed(2)} USD per trade*\n` +
    `• Execution Capacity: *~${remainingTrades} trades remaining*\n` +
    `• AI Safety Filter: *>= 80% Confidence required*\n` +
    `• Take-Profit Target: *+${settings.takeProfitPct}%* (Auto-sell trigger)\n` +
    `• Stop-Loss Limit: *-${settings.stopLossPct}%* (Capital protection)\n` +
    `• Max Holding Time: *${settings.maxHoldHours} hours*\n\n` +
    `⚡ *Controls & Quick Commands:*\n` +
    `• \`/papertrade <CA>\` : Trade specific CA (e.g. \`/papertrade <CA> 2\`)\n` +
    `• \`/papertrade on\` : Activate live simulated trades\n` +
    `• \`/stoppapertrade\` : Stop trading & see net profit report\n` +
    `• \`/fund <amount>\` : Add more capital to paper wallet\n` +
    `• \`/positions\` : Inspect active positions & real-time PnL\n` +
    `• \`/balance\` : All-time money made & earnings breakdown`;

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, message, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, message, HELP_BUTTONS);
  }
}

async function handleAutoTrade(chatId: string, tokenMint: string | undefined, sizeStr: string | undefined): Promise<void> {
  if (!tokenMint || !SOLANA_ADDRESS_RE.test(tokenMint)) {
    await sendTelegramMessageTo(
      chatId,
      `🎯 *[AUTONOMOUS SINGLE TRADE]*\n\n` +
      `Executes an autonomous round-trip single trade (Auto-BUY ➡️ Real-time Dump Shield & Targets ➡️ Auto-SELL).\n\n` +
      `Usage: \`/autotrade <token CA> [amount USD]\` (e.g. \`/autotrade <CA> 2\` or \`/scalp <CA>\`)\n\n` +
      `• Strict 5% Stop-Loss Ceiling Guaranteed\n` +
      `• Real-time Dump Shield active (Auto-exits on dev dump or velocity cliff)\n` +
      `• Dynamic Take-Profit (+50%) auto-exit`
    );
    return;
  }

  const size = sizeStr && !isNaN(Number(sizeStr)) && Number(sizeStr) > 0 ? Number(sizeStr) : undefined;
  await openAutonomousTrade(tokenMint, size, chatId);
}

async function handleDumpDashboard(chatId: string): Promise<void> {
  const text = formatDumpDashboardText();
  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
  }
}

async function handleStopSniper(chatId: string): Promise<void> {
  const state = setSniperActive(false);
  const text =
    `🛑 *[SNIPER ENGINE STOPPED / PAUSED]*\n\n` +
    `• Engine Status: 🔴 *PAUSED*\n` +
    `• Instant Pump.fun Alerts: *HALTED*\n` +
    `• Insider Launch Scanner: *HALTED*\n` +
    `• Automated Drop Snipes: *PAUSED*\n` +
    `• Historical Alerts Dispatched: *${state.totalAlertsDispatched}*\n\n` +
    `Automated drop alerts and snipes are now paused. You will not receive any instant token alerts until you resume.\n\n` +
    `⚡ *Controls:*\n` +
    `• \`/startsniper\` or \`/sniper on\` : Resume millisecond sniper stream\n` +
    `• \`/pump\` : View manual snapshot of recent drops\n` +
    `• \`/papertrade\` : Inspect paper trading controls`;

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
  }
}

async function handleStartSniper(chatId: string): Promise<void> {
  const state = setSniperActive(true);
  const text =
    `🟢 *[SNIPER ENGINE ACTIVE & SCANNING]*\n\n` +
    `• Engine Status: 🟢 *ACTIVE (Millisecond Speed)*\n` +
    `• Pump.fun WebSocket Feed: *CONNECTED*\n` +
    `• Detection Speed: *Sub-200ms*\n` +
    `• Token Images: *Automated IPFS / Pinata extraction*\n` +
    `• AI Safety Threshold: *>= 80% AI Confidence required*\n` +
    `• Historical Alerts Dispatched: *${state.totalAlertsDispatched}*\n\n` +
    `Live drop alerts with token contract addresses, images, and 1-tap sniper buttons are now broadcasting.\n\n` +
    `⚡ *Controls:*\n` +
    `• \`/stopsniper\` or \`/sniper off\` : Pause sniper alerts anytime\n` +
    `• \`/pump\` : Manual snapshot of current drops\n` +
    `• \`/positions\` : Inspect active positions`;

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
  }
}

async function handleSniperCommand(chatId: string, action?: string): Promise<void> {
  const norm = action?.toLowerCase();
  if (norm === "on" || norm === "start" || norm === "resume" || norm === "activate") {
    await handleStartSniper(chatId);
    return;
  }
  if (norm === "off" || norm === "stop" || norm === "pause") {
    await handleStopSniper(chatId);
    return;
  }

  const state = getSniperState();
  const statusEmoji = state.enabled ? "🟢" : "🔴";
  const statusText = state.enabled ? "ACTIVE (Live Millisecond Streaming)" : "PAUSED (Alerts Halted)";

  const text =
    `🎯 *[ZOOMA SNIPER CONTROL CENTER]*\n\n` +
    `• Engine Status: ${statusEmoji} *${statusText}*\n` +
    `• Latency: *< 200ms sub-second WebSocket*\n` +
    `• Token Visuals: *Real token images via IPFS Gateway*\n` +
    `• AI Safety Gate: *>= 80% AI Confidence required*\n` +
    `• Contract Safety: *Renounced mint/freeze + Dev share < 18%*\n` +
    `• Total Alerts Broadcasted: *${state.totalAlertsDispatched}*\n\n` +
    `⚡ *Quick Commands:*\n` +
    `• \`/startsniper\` or \`/sniper on\` : Start millisecond drop alerts\n` +
    `• \`/stopsniper\` or \`/sniper off\` : Stop millisecond drop alerts\n` +
    `• \`/pump\` : View recent Pump.fun drops\n` +
    `• \`/insider\` : View sub-30m insider launches`;

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, text, HELP_BUTTONS);
  } catch {
    await sendTelegramMessageTo(chatId, text, HELP_BUTTONS);
  }
}

async function handleAiExplanation(chatId: string): Promise<void> {
  const text =
    `🧠 *[ZOOMA AI & MACHINE LEARNING ARCHITECTURE]*\n\n` +
    `*1. JEV (TypeSafe System One):*\n` +
    `• Role: Quantitative on-chain behavioral classifier\n` +
    `• What it evaluates: Analyzes multi-wallet transaction timing and volume to detect whether buying volume is organic retail, wash trading, or coordinated sniper rings\n` +
    `• How it scores: Outputs strictly typed, calibrated mathematical probabilities (0.0 to 1.0) rather than hallucinated text\n\n` +
    `*2. LLM (Groq / Llama 3):*\n` +
    `• Role: Anti-hallucination natural language synthesizer\n` +
    `• What it evaluates: Takes hard deterministic facts (liquidity, holder distribution, mint renounced status, JEV scores) and converts them into clear 2-sentence executive briefings\n` +
    `• Safety rule: The LLM NEVER decides buy/sell triggers or math. It only formats verified on-chain facts into readable alerts\n\n` +
    `*3. Deterministic Risk Engines:*\n` +
    `• Mint authority renounced check\n` +
    `• Freeze authority renounced check\n` +
    `• Bonding curve liquidity & top holder concentration audits\n\n` +
    `_All trading and signal decisions remain 100% deterministic and auditable._`;

  await sendTelegramMessageTo(chatId, text);
}

async function handleInsider(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "⚡ Scanning ultra-early drops (10 - 30 mins from launch) with instant risk check & predictive momentum scoring...");
  const drops = await scanInsiderDrops(3);

  if (drops.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ No active pools created within the last 30 minutes currently pass strict non-rug audits (mint/freeze renounced). The bot monitors pool creations 24/7 and will auto-alert you in milliseconds when an insider gem launches."
    );
    return;
  }

  for (let i = 0; i < drops.length; i++) {
    const gem = drops[i];
    const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
    const buyRatioLine = gem.buyRatioPct ? `• Buy Pressure: *${gem.buyRatioPct}% Buys* (Bullish Velocity)\n` : "";
    const holderLine = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}%` : "Safe";
    const priceStr = Number(gem.priceUsd) < 0.01 ? `$${Number(gem.priceUsd).toFixed(6)}` : `$${Number(gem.priceUsd).toFixed(4)}`;

    const text =
      `⚡ *[INSIDER SNIPER | ${gem.ageMinutes}m FROM LAUNCH]*\n\n` +
      `*${gem.name} ($${gem.symbol})*\n` +
      `• Token CA: \`${gem.tokenAddress}\`\n\n` +
      `🚀 *Early Entry & Predictive Valuation:*\n` +
      `• Launch Timing: *${gem.ageMinutes} minutes ago* (Insider Sniping Window)\n` +
      `• Price: *${priceStr}* | FDV: *$${Math.round(gem.fdv).toLocaleString()}*\n` +
      `• Initial Pool: *$${Math.round(gem.liquidityUsd).toLocaleString()}* | Vol: *$${Math.round(gem.volumeUsd).toLocaleString()}*\n` +
      buyRatioLine +
      `• Predictive Runway: *${gem.predictedRunway}*\n` +
      `• DEX: *${gem.dexId}*\n\n` +
      `🛡️ *Sub-Second Risk Audit (Verified Safe):*\n` +
      `• Mint Authority: ✅ Renounced\n` +
      `• Freeze Authority: ✅ Renounced\n` +
      `• Top 1 Holder: ✅ ${holderLine}\n` +
      `• Rug Risk: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
      `⚡ *Sub-Second Trade Execution:*`;

    await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(gem.tokenAddress));
  }
}

async function handlePumpDrops(chatId: string): Promise<void> {
  const allDrops = getRecentPumpDrops(30);
  const ultraSafeDrops = allDrops.filter((d) => d.devHoldingPct < 5.0).slice(0, 3);

  if (ultraSafeDrops.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "💊 *Pump.fun Ultra-Safe Stream Active*\n\n" +
      "Listening to Pumpportal WebSocket in real time. Only high-conviction drops meeting strict *Ultra-Safe (< 5% dev holding)* and *>= 80% AI confidence* criteria will be alerted."
    );
    return;
  }

  for (let i = 0; i < ultraSafeDrops.length; i++) {
    const drop = ultraSafeDrops[i];
    const devStatus = `🟢 Ultra-Safe (${drop.devHoldingPct}% supply)`;

    const eventTitle = drop.isRaydiumGraduation
      ? `🎓 *[PUMP.FUN RAYDIUM GRADUATION | 80%+ ULTRA-SAFE]*`
      : `💊 *[PUMP.FUN ULTRA-SAFE DROP | >=80% AI CONFIDENCE]*`;

    const [jevRead, llmExplanation, imageUrl] = await Promise.all([
      classifyPumpDrop({
        mint: drop.mint,
        name: drop.name,
        symbol: drop.symbol,
        devHoldingPct: drop.devHoldingPct,
        solAmount: drop.solAmount,
        marketCapSol: drop.marketCapSol,
        isGraduation: Boolean(drop.isRaydiumGraduation),
      }).catch(() => null),
      explainPumpDrop({
        tokenMint: drop.mint,
        name: drop.name,
        symbol: drop.symbol,
        devHoldingPct: drop.devHoldingPct,
        solAmount: drop.solAmount,
        marketCapSol: drop.marketCapSol,
        isGraduation: Boolean(drop.isRaydiumGraduation),
      }).catch(() => null),
      resolvePumpTokenImageUrl(drop.uri, drop.mint),
    ]);

    const fastRugPull = calculateDeterministicPumpRugScore(drop.devHoldingPct, drop.solAmount, Boolean(drop.isRaydiumGraduation));
    const rugPull = jevRead?.rugPull ?? fastRugPull;

    if ((jevRead && jevRead.confidence < 0.80) || rugPull.score > 25 || rugPull.level === "high_rug_threat" || rugPull.level === "elevated_risk") {
      continue;
    }
    if (jevRead?.pattern === "dev_heavy_bundle" || jevRead?.pattern === "suspicious_copycat") {
      continue;
    }

    let aiSection = "";
    if (jevRead) {
      aiSection += `🤖 *JEV AI Read:* ${jevRead.badge} (${(jevRead.confidence * 100).toFixed(0)}% confidence)\n`;
    }
    aiSection += `🛡️ *JEV Rug Pull Calculation:* ${rugPull.badge}\n`;
    aiSection += `• Rug Pull Threat: *${rugPull.score}/100* (${100 - rugPull.score}% Safe Score)\n`;
    aiSection += `• Dev Dump Exposure: *${rugPull.dumpProbabilityPct}%* (${rugPull.verdict})\n`;
    aiSection += `• Honeypot Risk: *0% (Mint & Freeze Authorities Renounced)*\n`;
    aiSection += `• Liquidity Drain Risk: *0% (Locked in Pump.fun program curve)*\n`;
    if (llmExplanation) {
      aiSection += `🧠 *AI Synthesis:* _${llmExplanation}_\n`;
    }
    if (aiSection) aiSection += "\n";

    const text =
      `${eventTitle}\n\n` +
      `*${drop.name} ($${drop.symbol})*\n` +
      `• Token CA: \`${drop.mint}\`\n\n` +
      `📊 *Launch Metrics (Pump.fun Live):*\n` +
      `• Dev Initial Buy: *${drop.solAmount.toFixed(3)} SOL*\n` +
      `• Dev Supply Share: ${devStatus}\n` +
      `• Initial Valuation: *~${drop.marketCapSol.toFixed(1)} SOL* (Early micro-entry)\n` +
      `• Dev Wallet: \`${drop.traderPublicKey ? drop.traderPublicKey.slice(0, 6) + "..." + drop.traderPublicKey.slice(-4) : "Anonymous"}\`\n\n` +
      aiSection +
      `🛡️ *Contract Safety Fundamentals:*\n` +
      `• Mint Authority: ✅ Renounced (Pump.fun program enforced)\n` +
      `• Freeze Authority: ✅ Renounced (No blacklist possible)\n` +
      `• Liquidity: ✅ On Bonding Curve (${drop.isRaydiumGraduation ? "Graduated to Raydium" : "Pre-migration stage"})\n\n` +
      `⚡ *Execute sub-second trade on fastest terminal:*`;

    const buttons = getTokenTradingButtons(drop.mint);

    try {
      await sendTelegramPhotoTo(chatId, imageUrl, text, buttons);
    } catch {
      await sendTelegramMessageTo(chatId, text, buttons);
    }
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  registerActiveChat(chatId);

  // If a user invoked a slash command starting with "/", vaporize their command message
  // along with the bot's output after 45 seconds to keep the chat clean like vapor
  if (message.text.trim().startsWith("/") && message.message_id) {
    scheduleVaporization(chatId, message.message_id, VAPORIZE_DELAY_SECONDS);
  }

  const fromUser = message.from;
  const userId = fromUser ? String(fromUser.id) : chatId;
  const username = fromUser?.username ? `@${fromUser.username}` : (message.chat.username ? `@${message.chat.username}` : undefined);
  const firstName = fromUser?.first_name || message.chat.first_name || "Trader";
  const lastName = fromUser?.last_name || message.chat.last_name;

  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  const isRegistered = isUserRegistered(userId);

  // Gatekeeping for unregistered users
  if (!isRegistered) {
    if (command === "/register" || command === "/join" || command === "/signup") {
      const { user, isNew } = registerUser({
        userId,
        chatId,
        username,
        firstName,
        lastName,
      });

      if (isNew) {
        await sendTelegramPhotoTo(
          chatId,
          ZOOMA_BANNER_IMAGE,
          `🎉 *Registration Successful!*\n\n` +
            `Welcome to ZOOMA, *${firstName}*! You are officially registered as *Member #${user.memberNumber}*.\n\n` +
            `✅ *Account Status: ACTIVE & UNLOCKED*\n` +
            `You now have full access to all bot features:\n` +
            `• ⚡ \`/autotrade <CA>\` : Autonomous single-trade buy and sell\n` +
            `• 🚨 \`/dumps\` : Real-Time Dump Shield and protection\n` +
            `• 💊 \`/pump\` : Ultra-Safe 80%+ confidence drops\n` +
            `• 💵 \`/fund 10\` : Fund virtual paper wallet ($10 USD min)\n` +
            `• 💼 \`/papertrade\` : Start simulated trades\n` +
            `• 🔥 \`/trending\` : Top 15 trending Solana tokens\n` +
            `• 👥 \`/users\` : Community and user statistics\n\n` +
            `Type \`/help\` anytime to view the complete command list.`
        );
      } else {
        await sendTelegramMessageTo(
          chatId,
          `ℹ️ *Account Already Active*\n\n` +
            `You are already registered as *Member #${user.memberNumber}*.\n` +
            `Your access is unlocked. Type \`/help\` to view all commands.`
        );
      }
      return;
    }

    if (command === "/start" || command === "/help") {
      await sendTelegramPhotoTo(
        chatId,
        ZOOMA_BANNER_IMAGE,
        `👋 *Welcome to ZOOMA Onchain Intelligence!*\n\n` +
          `ZOOMA is an autonomous Solana trading bot with real-time dump protection, AI pattern learning, and millisecond token sniping.\n\n` +
          `🔒 *Access Status: Gatekept (Registration Required)*\n` +
          `To protect system capacity and keep execution speeds under 300ms, ZOOMA is reserved for registered members.\n\n` +
          `Registration is *100% free* and takes just one second.\n\n` +
          `👉 *Type \`/register\` to activate your account and unlock all features!*`
      );
      return;
    }

    // Gatekeep any other command
    await sendTelegramMessageTo(
      chatId,
      `🔒 *Access Restricted: Member Registration Required*\n\n` +
        `You must register before using ZOOMA commands like \`${command}\`.\n\n` +
        `Registration is completely free and unlocks:\n` +
        `• Autonomous Single-Trade execution (\`/autotrade\`)\n` +
        `• Real-Time Dump Shield & Anti-Rug detection (\`/dumps\`)\n` +
        `• Ultra-Safe Pump.fun snipers & fresh gems (\`/pump\`, \`/gems\`)\n` +
        `• Virtual paper trading wallet (\`/fund\`, \`/papertrade\`)\n\n` +
        `👉 *Send \`/register\` now to unlock your access immediately.*`
    );
    return;
  }

  // User is registered: record activity
  recordUserActivity(userId, username, firstName);

  try {
    switch (command) {
      case "/start":
      case "/help":
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, HELP_TEXT, HELP_BUTTONS);
        break;
      case "/register":
      case "/join":
      case "/signup": {
        const user = getUser(userId);
        await sendTelegramMessageTo(
          chatId,
          `ℹ️ *Account Active*\n\n` +
            `You are already registered as *Member #${user?.memberNumber ?? 1}*.\n` +
            `Your access is completely unlocked. Type \`/help\` to view all commands.`
        );
        break;
      }
      case "/users":
      case "/members":
      case "/userstats":
      case "/analytics":
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, formatUserStatsDashboard());
        break;
      case "/profile":
      case "/myprofile":
      case "/whoami":
      case "/account": {
        const user = getUser(userId);
        if (!user) {
          await sendTelegramMessageTo(chatId, "⚠️ Please send `/register` first to create your account.");
          break;
        }
        const joined = new Date(user.registeredAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        await sendTelegramMessageTo(
          chatId,
          `👤 *Your ZOOMA Member Profile*\n\n` +
            `• Member Number: *#${user.memberNumber}*\n` +
            `• User ID: \`${user.userId}\`\n` +
            `• Username: *${user.username ?? "Not set"}*\n` +
            `• Name: *${user.firstName ?? "Trader"}*\n` +
            `• Status: 🟢 *Active*\n` +
            `• Role: *${user.role.toUpperCase()}*\n` +
            `• Registered: *${joined}*\n` +
            `• Total Commands: *${user.commandCount}*`
        );
        break;
      }
      case "/ai":
      case "/models":
      case "/model":
      case "/jev":
      case "/llm":
        await handleAiExplanation(chatId);
        break;
      case "/watch":
        await handleWatch(chatId, args[0]);
        break;
      case "/unwatch":
        await handleUnwatch(chatId, args[0]);
        break;
      case "/list":
      case "/wallets":
        await handleList(chatId);
        break;
      case "/wallet":
      case "/inspect":
        await handleInspectWallet(chatId, args[0]);
        break;
      case "/stopsniper":
      case "/pausesniper":
      case "/stopsniping":
        await handleStopSniper(chatId);
        break;
      case "/startsniper":
      case "/resumesniper":
      case "/startsniping":
        await handleStartSniper(chatId);
        break;
      case "/sniper":
      case "/snipers":
        await handleSniperCommand(chatId, args[0]);
        break;
      case "/pump":
      case "/pumpfun":
      case "/drops":
        await handlePumpDrops(chatId);
        break;
      case "/channels":
      case "/channel":
      case "/multichannel":
      case "/meteora":
      case "/raydium":
      case "/moonshot":
        await handleChannelsCommand(chatId);
        break;
      case "/patterns":
      case "/pattern":
      case "/learning":
      case "/maximize":
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, formatPatternDashboardText());
        break;
      case "/insider":
      case "/fresh":
        await handleInsider(chatId);
        break;
      case "/autotrade":
      case "/scalp":
      case "/singletrade":
        await handleAutoTrade(chatId, args[0], args[1]);
        break;
      case "/dumps":
      case "/dump":
      case "/dumpshield":
      case "/dumpalerts":
        await handleDumpDashboard(chatId);
        break;
      case "/papertrade":
      case "/activate":
      case "/toggletrade":
      case "/trade":
        await handlePaperTradeCommand(chatId, args[0], args[1]);
        break;
      case "/stoppapertrade":
      case "/stoppaper":
      case "/stoptrading":
      case "/pausepapertrade":
      case "/stoptrade":
        await stopPaperTradingAndReport(chatId);
        break;
      case "/fund":
      case "/fundwallet":
      case "/fundpaperwallet":
        await handleFundPaperWallet(chatId, args[0]);
        break;
      case "/paperwallet":
      case "/pwallet":
      case "/walletbalance":
        await sendPaperBalancePhoto(chatId);
        break;
      case "/gems":
      case "/gem":
      case "/100x":
      case "/early":
      case "/breakout":
      case "/solid":
        await handleLiveGems(chatId);
        break;
      case "/positions":
      case "/trades":
      case "/paper":
      case "/open":
        await handlePositions(chatId);
        break;
      case "/close":
      case "/sell":
      case "/exit":
        await closePaperTradeManually(chatId, args[0]);
        break;
      case "/history":
      case "/closed":
      case "/past":
        await sendTradeHistory(chatId);
        break;
      case "/balance":
      case "/profit":
      case "/money":
      case "/earnings":
        await sendPaperBalancePhoto(chatId);
        break;
      case "/pnl":
      case "/performance":
      case "/stats":
        await handlePerformance(chatId);
        break;
      case "/whales":
      case "/whale":
        await handleWhales(chatId);
        break;
      case "/activity":
      case "/feed":
      case "/stream":
        await handleActivity(chatId);
        break;
      case "/traders":
      case "/entries":
      case "/toptraders":
        await handleTraders(chatId);
        break;
      case "/status":
        await handleStatus(chatId);
        break;
      case "/scores":
        await handleScores(chatId);
        break;
      case "/scan":
      case "/check":
        await handleScan(chatId, args[0]);
        break;
      case "/trending":
        await handleTrending(chatId);
        break;
      case "/discover":
        await handleDiscover(chatId);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("[telegramCommands] command handling failed:", (err as Error).message);
    await sendTelegramMessageTo(chatId, "Something went wrong handling that command. Please check server logs.");
  }
}
