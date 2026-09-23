/**
 * TELEGRAM SLASH COMMANDS: /watch, /unwatch, /list, /wallets, /status, /scores,
 * /scan, /trending, /traders, /discover, /help.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessageTo, sendTelegramPhotoTo } from "./telegram.js";
import { refreshWebhookWithCurrentWallets, runDiscoveryOnce } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";
import { fetchTokenPairs, fetchLatestBoostedSolanaTokens, getTokenImageUrl } from "./researchSources.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { openTrendingPaperTrade } from "./paperTrading.js";
import { getRecentTraderEntries, formatTraderEntriesText } from "./topTraders.js";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

const HELP_TEXT =
  `🤖 *Onchain Intelligence Bot | Command Center*\n\n` +
  `*Tracked Wallets & Smart Money:*\n` +
  `• \`/list\` or \`/wallets\` : View all currently tracked wallets\n` +
  `• \`/watch <address>\` : Add a wallet to real-time tracking\n` +
  `• \`/unwatch <address>\` : Remove a wallet from tracking\n` +
  `• \`/traders\` : View recent entries of smart money traders\n` +
  `• \`/discover\` : Trigger an instant wallet discovery pass\n\n` +
  `*Security & Fast Trading:*\n` +
  `• \`/scan <token CA>\` : Complete rug check, photo, liquidity & fast trade links\n` +
  `• \`/trending\` : Live trending Solana meme coins with sniper buttons\n\n` +
  `*Analytics & Track Record:*\n` +
  `• \`/status\` : 24h signal activity and open paper positions\n` +
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

  let text = `📋 *Tracked Wallets (${wallets.length} Active in Real-Time)*\n\n`;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const short = `\`${w.address}\``;
    text += `${i + 1}. ${short}\n   🏷️ Source: _${w.source}_\n`;
  }
  text += `\n_Helius webhook actively monitors all on-chain SWAP transactions for these addresses._`;

  await sendTelegramMessageTo(chatId, text);
}

async function handleStatus(chatId: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { count: signalCount } = await supabase
    .from("signals")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);

  const { count: openTrades } = await supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("status", "open");
  const { count: closedTrades } = await supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("status", "closed");

  await sendTelegramMessageTo(
    chatId,
    `📊 *System Status & Activity (Last 24h)*\n\n` +
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
  await sendTelegramMessageTo(chatId, "🔥 Fetching live trending Solana tokens...");
  const boosted = await fetchLatestBoostedSolanaTokens().catch(() => []);
  if (boosted.length === 0) {
    await sendTelegramMessageTo(chatId, "No trending tokens returned right now. Please check again in a minute.");
    return;
  }

  const top5 = boosted.slice(0, 5);
  let text = `🔥 *Top Trending Solana Tokens (DexScreener Live)*\n\n`;
  for (let i = 0; i < top5.length; i++) {
    const t = top5[i];
    text += `${i + 1}. \`${t.tokenAddress}\`\n`;
    openTrendingPaperTrade(t.tokenAddress).catch(() => {});
  }
  text += `\n_Live simulated paper trade positions opened._\n_Use /scan <CA> for full security audit or tap any quick-trade button._`;

  const buttons = top5.slice(0, 3).map((t) => [
    { text: `⚡ Photon (${t.tokenAddress.slice(0, 4)}...)`, url: `https://photon-sol.tinyastro.io/en/lp/${t.tokenAddress}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${t.tokenAddress}` },
    { text: `📊 DexS`, url: `https://dexscreener.com/solana/${t.tokenAddress}` },
  ]);

  await sendTelegramMessageTo(chatId, text, buttons);
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

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  const [command, ...args] = message.text.trim().split(/\s+/);

  try {
    switch (command.split("@")[0]) {
      case "/start":
        await sendTelegramMessageTo(
          chatId,
          `👋 Onchain Intelligence Bot online.\nReal-time Helius tracking active. Send /help to view all commands.`
        );
        break;
      case "/help":
        await sendTelegramMessageTo(chatId, HELP_TEXT);
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
