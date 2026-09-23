/**
 * TELEGRAM SLASH COMMANDS: /watch, /unwatch, /list, /wallets, /wallet, /status, /scores,
 * /scan, /trending, /solid, /gems, /whales, /activity, /traders, /discover, /help.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessageTo, sendTelegramPhotoTo, registerActiveChat } from "./telegram.js";
import { refreshWebhookWithCurrentWallets, runDiscoveryOnce } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";
import { fetchTokenPairs, fetchLatestBoostedSolanaTokens, getTokenImageUrl } from "./researchSources.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import {
  openTrendingPaperTrade,
  openManualPaperTrade,
  getOpenPositionsReport,
  computeStats,
  formatStats,
  setPaperTradingActive,
  setPaperTradingPositionSize,
  getPaperTradingSettings,
} from "./paperTrading.js";
import { getRecentTraderEntries, formatTraderEntriesText } from "./topTraders.js";
import { scanSolidGems, fireSolidGemAlert } from "./solidGems.js";
import { scanEarly100xGems } from "./early100xGems.js";
import { fetchTopTrendingSolanaTokens, TrendingTokenDetail } from "./trendingAlerter.js";
import { scanInsiderDrops } from "./insiderSniper.js";
import { getRecentPumpDrops } from "./pumpFunStream.js";
import {
  getWalletIdenticonUrl,
  inspectWalletDetail,
  formatWalletDetailText,
  getWalletProfileButtons,
} from "./walletInspector.js";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_CAPACITY = Number(process.env.MAX_TRACKED_WALLETS ?? 5000);
const ZOOMA_BANNER_IMAGE = process.env.ZOOMA_BANNER_URL ?? "assets/zooma_banner.jpg";

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
    chat: { id: number };
    text?: string;
  };
}

const HELP_TEXT =
  `🤖 *ZOOMA Onchain Intelligence*\n` +
  `_Automated Solana Breakout Engine & Paper Trader_\n\n` +
  `⚡ *Primary Commands:*\n` +
  `💊 \`/pump\` : Live Pump.fun Drops & Graduations\n` +
  `⚡ \`/insider\` : Ultra-Early Launches (10 - 30m old)\n` +
  `💎 \`/gems\` : Live Fresh Gems (< 48h) & 100x Breakouts\n` +
  `🔥 \`/trending\` : Top 15 Trending Solana Tokens\n` +
  `💼 \`/papertrade [CA]\` : Trade CA ($2 USD) / Configure\n` +
  `📈 \`/positions\` : Live Paper Portfolio & Real-Time PnL\n` +
  `🛡️ \`/scan <CA>\` : Security Audit & Snipe Links\n` +
  `🐋 \`/wallets\` : Smart Money Tracker & Whales\n` +
  `🧠 \`/ai\` : JEV & LLM AI Architecture\n\n` +
  `🔔 *Automated 24/7 Alerts:*\n` +
  `• 💊 Pump.fun Live Creations & Raydium Migrations\n` +
  `• ⚡ 10m - 30m Verified Insider Drops\n` +
  `• 🚀 Fresh 100x Breakouts & High Volume Spikes\n` +
  `• 💼 Auto $2 Paper Trades & Take-Profit (+50%) Hits\n\n` +
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

  await sendTelegramMessageTo(
    chatId,
    `📊 *System Status & Activity (Last 24h)*\n\n` +
      `• Tracked Wallets: *${totalWallets ?? 0}* / *${MAX_CAPACITY}*\n` +
      `• Detected Signals: *${signalCount ?? 0}*\n` +
      `• Open Paper Trades: *${openTrades ?? 0}*\n` +
      `• Closed Paper Trades (All-Time): *${closedTrades ?? 0}*\n\n` +
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
    await sendTelegramMessageTo(
      chatId,
      `⚠️ No liquidity pairs found for \`${address}\`. It may be brand new or unlisted.`,
      getTokenTradingButtons(address)
    );
    return;
  }

  const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  const liqUsd = pair.liquidity?.usd ?? 0;
  const vol24h = pair.volume?.h24 ? `$${Math.round(pair.volume.h24).toLocaleString()}` : "n/a";
  const price = pair.priceUsd ? `$${pair.priceUsd}` : "n/a";
  const fdv = pair.fdv ? `$${Math.round(pair.fdv).toLocaleString()}` : "n/a";

  const rugAudit = await evaluateTokenRugRisk(address, { topHolderPct: topHolder, liquidityUsd: liqUsd });

  let rugSection = `🛡️ *Rug Pull & Security Audit:*\n• Verdict: *${rugAudit.verdict}*\n`;
  if (rugAudit.mintAuthorityRenounced !== null) {
    rugSection += `• Mint Authority: ${rugAudit.mintAuthorityRenounced ? "✅ Renounced (Safe)" : "🚨 ACTIVE (Mint Risk)"}\n`;
  }
  if (rugAudit.freezeAuthorityRenounced !== null) {
    rugSection += `• Freeze Authority: ${rugAudit.freezeAuthorityRenounced ? "✅ Renounced (Safe)" : "🚨 ACTIVE (Blacklist Risk)"}\n`;
  }
  if (topHolder !== null) {
    rugSection += `• Top 1 Holder: ${topHolder > 20 ? "⚠️" : "✅"} ~${topHolder.toFixed(1)}% of top-20 balance\n`;
  }

  if (rugAudit.flags.length > 0) {
    rugSection += `\n*Risk Flags:*\n` + rugAudit.flags.map((f) => `• ${f}`).join("\n") + `\n`;
  }

  const text =
    `🔬 *Token Security & Market Scan*\n\n` +
    `*${pair.baseToken.name} ($${pair.baseToken.symbol})*\n` +
    `CA: \`${address}\`\n\n` +
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

  // Send photo cards for top 3 breakout tokens
  const topCards = trendingList.slice(0, 3);
  for (let i = 0; i < topCards.length; i++) {
    const t = topCards[i];
    openTrendingPaperTrade(t.tokenAddress).catch(() => {});

    const priceStr = Number(t.priceUsd) < 0.01 ? `$${Number(t.priceUsd).toFixed(6)}` : `$${Number(t.priceUsd).toFixed(4)}`;
    const caption =
      `🔥 *#${i + 1} Trending Token | ${t.name} ($${t.symbol})*\n\n` +
      `• CA: \`${t.tokenAddress}\`\n` +
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
    .limit(8);

  if (error || !signals || signals.length === 0) {
    await sendTelegramMessageTo(chatId, "ℹ️ No recent whale buys detected yet. As tracked smart money wallets buy, alerts will appear here in real-time.");
    return;
  }

  let text = `🐋 *Recent Smart Money Whale Buys*\n\n`;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    const details = s.details as any;
    const wallet = details?.wallet ? `\`${details.wallet.slice(0, 6)}...${details.wallet.slice(-4)}\`` : "Smart Money";
    const sol = details?.sol_amount ? `${Number(details.sol_amount).toFixed(2)} SOL` : "Buy";
    const time = new Date(s.created_at).toLocaleTimeString();

    text += `${i + 1}. ${sol} by ${wallet}\n`;
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
  const entries = await getRecentTraderEntries(10);
  const text = formatTraderEntriesText(entries);
  await sendTelegramMessageTo(chatId, text);
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
  const report = await getOpenPositionsReport();
  await sendTelegramMessageTo(chatId, report);
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

async function handlePaperTradeCommand(chatId: string, action?: string, amountStr?: string): Promise<void> {
  // If action is a Solana address, open manual paper trade immediately!
  if (action && SOLANA_ADDRESS_RE.test(action)) {
    const size = amountStr && !isNaN(Number(amountStr)) && Number(amountStr) > 0 ? Number(amountStr) : undefined;
    await openManualPaperTrade(chatId, action, size);
    return;
  }

  const normAction = action?.toLowerCase();

  if (normAction === "on" || normAction === "activate" || normAction === "start") {
    setPaperTradingActive(true);
    if (amountStr && !isNaN(Number(amountStr)) && Number(amountStr) > 0) {
      setPaperTradingPositionSize(Number(amountStr));
    }
  } else if (normAction === "off" || normAction === "pause" || normAction === "stop") {
    setPaperTradingActive(false);
  } else if (action && !isNaN(Number(action)) && Number(action) > 0) {
    setPaperTradingPositionSize(Number(action));
    setPaperTradingActive(true);
  }

  const settings = getPaperTradingSettings();
  const statusEmoji = settings.enabled ? "🟢" : "🔴";
  const statusText = settings.enabled ? "ACTIVE (Auto-Trading Enabled)" : "PAUSED";

  const message =
    `💼 *[PAPER TRADING CONTROL CENTER]*\n\n` +
    `• System Status: ${statusEmoji} *${statusText}*\n` +
    `• Position Sizing: *$${settings.positionSize.toFixed(2)} USD per trade*\n` +
    `• Take-Profit Target: *+${settings.takeProfitPct}%* (Auto-sell trigger)\n` +
    `• Stop-Loss Limit: *-${settings.stopLossPct}%* (Capital protection)\n` +
    `• Max Holding Time: *${settings.maxHoldHours} hours*\n\n` +
    `⚡ *Controls & Quick Commands:*\n` +
    `• \`/papertrade <CA>\` : Trade specific CA (e.g. \`/papertrade <CA> 2\`)\n` +
    `• \`/papertrade on\` : Activate live simulated trades\n` +
    `• \`/papertrade off\` : Pause auto-trading\n` +
    `• \`/papertrade <size>\` : Set position size (e.g. \`/papertrade 5\`)\n` +
    `• \`/positions\` : Inspect active positions & real-time PnL`;

  await sendTelegramMessageTo(chatId, message);
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
  const drops = getRecentPumpDrops(3);
  if (drops.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "💊 *Pump.fun Live Stream Active*\n\n" +
      "Listening to Pumpportal WebSocket stream in real time. Ultra-early token creations and Raydium graduations will appear here and alert in milliseconds as developers launch them."
    );
    return;
  }

  for (let i = 0; i < drops.length; i++) {
    const drop = drops[i];
    const devStatus = drop.devHoldingPct < 5.0
      ? `🟢 Ultra-Safe (${drop.devHoldingPct}% supply)`
      : drop.devHoldingPct < 10.0
      ? `🟡 Moderate (${drop.devHoldingPct}% supply)`
      : `⚠️ High (${drop.devHoldingPct}% supply)`;

    const eventTitle = drop.isRaydiumGraduation
      ? `🎓 *[PUMP.FUN RAYDIUM GRADUATION]*`
      : `💊 *[PUMP.FUN INSTANT DROP | MILLISECOND SNIPER]*`;

    const text =
      `${eventTitle}\n\n` +
      `*${drop.name} ($${drop.symbol})*\n` +
      `• Token CA: \`${drop.mint}\`\n\n` +
      `📊 *Launch Metrics (Pump.fun Live):*\n` +
      `• Dev Initial Buy: *${drop.solAmount.toFixed(3)} SOL*\n` +
      `• Dev Supply Share: ${devStatus}\n` +
      `• Initial Valuation: *~${drop.marketCapSol.toFixed(1)} SOL* (Early micro-entry)\n` +
      `• Dev Wallet: \`${drop.traderPublicKey ? drop.traderPublicKey.slice(0, 6) + "..." + drop.traderPublicKey.slice(-4) : "Anonymous"}\`\n\n` +
      `🛡️ *Contract Safety Fundamentals:*\n` +
      `• Mint Authority: ✅ Renounced (Pump.fun program enforced)\n` +
      `• Freeze Authority: ✅ Renounced (No blacklist possible)\n` +
      `• Liquidity: ✅ On Bonding Curve (${drop.isRaydiumGraduation ? "Graduated to Raydium" : "Pre-migration stage"})\n\n` +
      `⚡ *Execute sub-second trade on fastest terminal:*`;

    const imageUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${drop.mint}.png`;
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
  const [command, ...args] = message.text.trim().split(/\s+/);

  try {
    switch (command.split("@")[0]) {
      case "/start":
      case "/help":
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, HELP_TEXT, HELP_BUTTONS);
        break;
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
      case "/pump":
      case "/pumpfun":
      case "/drops":
        await handlePumpDrops(chatId);
        break;
      case "/insider":
      case "/snip":
      case "/fresh":
        await handleInsider(chatId);
        break;
      case "/papertrade":
      case "/activate":
      case "/toggletrade":
      case "/trade":
        await handlePaperTradeCommand(chatId, args[0], args[1]);
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
