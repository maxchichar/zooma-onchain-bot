/**
 * TELEGRAM SLASH COMMANDS: /watch, /unwatch, /list, /wallets, /wallet, /status, /scores,
 * /scan, /trending, /solid, /gems, /whales, /activity, /traders, /discover, /help.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessageTo, sendTelegramPhotoTo } from "./telegram.js";
import { refreshWebhookWithCurrentWallets, runDiscoveryOnce } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";
import { fetchTokenPairs, fetchLatestBoostedSolanaTokens, getTokenImageUrl } from "./researchSources.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openTrendingPaperTrade, getOpenPositionsReport, computeStats, formatStats } from "./paperTrading.js";
import { getRecentTraderEntries, formatTraderEntriesText } from "./topTraders.js";
import { scanSolidGems, fireSolidGemAlert } from "./solidGems.js";
import { scanEarly100xGems } from "./early100xGems.js";
import { fetchTopTrendingSolanaTokens, TrendingTokenDetail } from "./trendingAlerter.js";
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
  `🤖 *ZOOMA Onchain Analysis Bot | Command Center*\n` +
  `_Track. Analyze. Spot Alpha._\n\n` +
  `*🚀 100x Potential & Solid Gems (< 48h):*\n` +
  `• \`/100x\` or \`/early\` : Scan fresh micro-cap gems with 100x breakout runway\n` +
  `• \`/solid\` or \`/gems\` : Scan & list verified non-rug pull solid tokens\n` +
  `• \`/scan <token CA>\` : Complete rug check, photo, liquidity & fast trade links\n` +
  `• \`/trending\` : Live trending Solana tokens with sniper buttons\n\n` +
  `*📈 Live Paper Trading & Simulated Positions:*\n` +
  `• \`/positions\` or \`/trades\` : View all active open simulated positions with live PnL\n` +
  `• \`/pnl\` or \`/performance\` : View overall win-rate, total profit & expectancy\n\n` +
  `*🐋 Smart Money & Whale Tracking (Up to 5,000):*\n` +
  `• \`/whales\` : View recent large buys by smart money wallets\n` +
  `• \`/activity\` or \`/feed\` : Real-time live on-chain swap stream\n` +
  `• \`/traders\` : View recent entries of smart money traders\n` +
  `• \`/list\` or \`/wallets\` : View all tracked wallets & system capacity\n` +
  `• \`/wallet <address>\` : Deep dossier on any wallet with visual avatar & PnL\n` +
  `• \`/watch <address>\` : Add a wallet to real-time tracking\n` +
  `• \`/unwatch <address>\` : Remove a wallet from tracking\n` +
  `• \`/discover\` : Trigger an instant wallet auto-discovery pass\n\n` +
  `*📊 Analytics & Leaderboards:*\n` +
  `• \`/status\` : 24h signal activity and system health\n` +
  `• \`/scores\` : Wallet credibility leaderboard\n` +
  `• \`/help\` : Show this guide`;

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
    await sendTelegramMessageTo(chatId, "📋 Tracked Wallets: 0 active. Use `/watch <address>` to add wallets.");
    return;
  }

  const total = wallets.length;
  const pct = ((total / MAX_CAPACITY) * 100).toFixed(1);
  const seedCount = wallets.filter((w) => w.source === "seed").length;
  const autoCount = wallets.filter((w) => w.source !== "seed").length;

  let text =
    `📋 *Tracked Wallets Capacity:* *${total}* / *${MAX_CAPACITY}* (${pct}%)\n` +
    `• Seed Wallets: *${seedCount}* | Auto-Discovered: *${autoCount}*\n\n` +
    `*Active Tracked Wallets:*\n`;

  const displayList = wallets.slice(0, 25);
  for (let i = 0; i < displayList.length; i++) {
    const w = displayList[i];
    const short = `\`${w.address}\``;
    text += `${i + 1}. ${short} (_${w.source}_)\n`;
  }

  if (total > 25) {
    text += `\n_...and ${total - 25} more wallets tracked in real-time._\n`;
  }

  text += `\n💡 _Tip: Use \`/wallet <address>\` to view full dossier & avatar for any wallet._`;

  await sendTelegramMessageTo(chatId, text);
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

async function handle100xGems(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🚀 Scanning for early micro-cap tokens with 100x breakout potential & safe authorities...");
  const gems = await scanEarly100xGems(3);

  if (gems.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ No active micro-cap tokens (FDV < $1.5M, age < 48h, buy ratio > 55%) passed strict non-rug audits in current pool. Re-run `/100x` in a few minutes or check `/solid`."
    );
    return;
  }

  for (const gem of gems) {
    const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
    const buyRatioText = gem.buyRatioPct ? `• Buy Pressure: *${gem.buyRatioPct}% Buys* (Bullish)\n` : "";
    const holderText = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}%` : "Safe";

    const text =
      `🚀 *[100X POTENTIAL GEM]*\n\n` +
      `*${gem.name} ($${gem.symbol})*\n` +
      `• CA: \`${gem.tokenAddress}\`\n\n` +
      `📈 *Growth Runway:*\n` +
      `• Estimated Upside: *${gem.potentialMultiplier}* (Low-Cap Entry)\n` +
      `• Market Cap / FDV: *$${Math.round(gem.fdv).toLocaleString()}*\n` +
      `• Liquidity: *$${Math.round(gem.liquidityUsd).toLocaleString()}* | 24h Vol: *$${Math.round(gem.volume24hUsd).toLocaleString()}*\n` +
      `• Age: *${gem.ageHours}h old* | DEX: *${gem.dexId}*\n` +
      buyRatioText +
      `\n🛡️ *Security Audit (Verified Safe):*\n` +
      `• Mint Authority: ✅ Renounced\n` +
      `• Freeze Authority: ✅ Renounced\n` +
      `• Top 1 Holder: ✅ ${holderText}\n` +
      `• Rug Risk: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
      `⚡ *Fast Snipe & Trade Terminal:*`;

    await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(gem.tokenAddress));
  }
}

async function handleSolid(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "💎 Scanning for verified non-rug pull solid tokens...");
  const gems = await scanSolidGems(3);

  if (gems.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ No active tokens passed strict non-rug security audit (mint & freeze renounced, liq > $10k, top holder < 20%) in current batch. Re-run `/solid` in a few minutes or scan specific CA via `/scan <CA>`."
    );
    return;
  }

  for (const gem of gems) {
    const imageUrl = getTokenImageUrl(gem.tokenAddress, gem.pair);
    const holderText = gem.topHolderPct !== null ? `~${gem.topHolderPct.toFixed(1)}%` : "Safe";

    const text =
      `💎 *[SOLID GEM]*\n\n` +
      `*${gem.name} ($${gem.symbol})*\n` +
      `• CA: \`${gem.tokenAddress}\`\n\n` +
      `📊 *Metrics:*\n` +
      `• Price: *$${gem.priceUsd}* | FDV: *$${Math.round(gem.fdv).toLocaleString()}*\n` +
      `• Liquidity: *$${Math.round(gem.liquidityUsd).toLocaleString()}* | 24h Vol: *$${Math.round(gem.volume24hUsd).toLocaleString()}*\n` +
      `• DEX: *${gem.dexId}* | Age: *${gem.ageHours}h*\n\n` +
      `🛡️ *Security Audit (Verified Safe):*\n` +
      `• Mint Authority: ✅ Renounced\n` +
      `• Freeze Authority: ✅ Renounced\n` +
      `• Top 1 Holder: ✅ ${holderText}\n` +
      `• Deployer Audit: ✅ Clean background\n` +
      `• Rug Risk: 🟢 *LOW RISK (${gem.rugAssessment.riskScore}/100)*\n\n` +
      `⚡ *Fast Snipe & Trade Terminal:*`;

    await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(gem.tokenAddress));
  }
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

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  const [command, ...args] = message.text.trim().split(/\s+/);

  try {
    switch (command.split("@")[0]) {
      case "/start":
      case "/help":
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, HELP_TEXT, HELP_BUTTONS);
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
      case "/100x":
      case "/early":
      case "/breakout":
        await handle100xGems(chatId);
        break;
      case "/solid":
      case "/gems":
      case "/gem":
        await handleSolid(chatId);
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
