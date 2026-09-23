/**
 * TELEGRAM SLASH COMMANDS — /watch, /unwatch, /list, /status, /scores,
 * /scan, /trending, /discover, /help. Received via Telegram webhook.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessageTo, sendTelegramPhotoTo } from "./telegram.js";
import { refreshWebhookWithCurrentWallets, runDiscoveryOnce } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";
import { fetchTokenPairs, fetchLatestBoostedSolanaTokens, getTokenImageUrl } from "./researchSources.js";
import { checkMintAuthorities } from "./rugRisk.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { getTokenTradingButtons } from "./tradeLinks.js";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

const HELP_TEXT =
  `🤖 *Onchain Intelligence Bot — Commands*\n\n` +
  `*Wallet Tracking:*\n` +
  `/watch <address> — start tracking a wallet (updates Helius in ms)\n` +
  `/unwatch <address> — stop tracking a wallet\n` +
  `/list — show tracked wallet count & sample\n` +
  `/discover — trigger live wallet auto-discovery immediately\n\n` +
  `*Token Scanning & Fast Trading:*\n` +
  `/scan <token CA> — instant rug check, liquidity, & fast trade links\n` +
  `/trending — live trending Solana meme coins with sniper buttons\n\n` +
  `*Performance & Stats:*\n` +
  `/status — recent signals and open paper trades\n` +
  `/scores — top and bottom wallet credibility scores\n` +
  `/help — show this message`;

async function handleWatch(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "Usage: `/watch <solana wallet address>` — that doesn't look like a valid address.");
    return;
  }

  const { error } = await supabase.from("tracked_wallets").insert({ address, source: "seed" });
  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessageTo(chatId, `Already tracking \`${address}\`.`);
    } else {
      await sendTelegramMessageTo(chatId, `Failed to add wallet: ${error.message}`);
    }
    return;
  }

  await refreshWebhookWithCurrentWallets();
  await sendTelegramMessageTo(chatId, `✅ Now tracking \`${address}\`. Helius webhook updated — you'll get real-time alerts on its future activity.`);
}

async function handleUnwatch(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "Usage: `/unwatch <solana wallet address>`");
    return;
  }

  const { error, count } = await supabase.from("tracked_wallets").delete({ count: "exact" }).eq("address", address);
  if (error) {
    await sendTelegramMessageTo(chatId, `Failed to remove wallet: ${error.message}`);
    return;
  }
  if (!count) {
    await sendTelegramMessageTo(chatId, `\`${address}\` wasn't being tracked.`);
    return;
  }

  await refreshWebhookWithCurrentWallets();
  await sendTelegramMessageTo(chatId, `✅ Stopped tracking \`${address}\`. Helius webhook updated.`);
}

async function handleList(chatId: string): Promise<void> {
  const { count } = await supabase.from("tracked_wallets").select("*", { count: "exact", head: true });
  const { data: sample } = await supabase.from("tracked_wallets").select("address, source").order("added_at", { ascending: false }).limit(5);

  const sampleLines = (sample ?? []).map((w) => `\`${w.address.slice(0, 6)}...${w.address.slice(-4)}\` (${w.source})`).join("\n");

  await sendTelegramMessageTo(
    chatId,
    `📋 *Tracked wallets:* ${count ?? 0}\n\nMost recently added:\n${sampleLines || "(none yet)"}`
  );
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
    `📊 *Status*\n\n` +
      `Signals in the last 24h: ${signalCount ?? 0}\n` +
      `Open paper trades: ${openTrades ?? 0}\n` +
      `Closed paper trades (all time): ${closedTrades ?? 0}\n\n` +
      `_For full performance numbers, run \`npm run report\` — the daily digest also covers this automatically._`
  );
}

async function handleScores(chatId: string): Promise<void> {
  const results = await computeAllWalletScores();
  const scored = results.filter((r) => r.tradesWithOutcome > 0);

  if (scored.length === 0) {
    await sendTelegramMessageTo(chatId, `No wallets have a closed paper trade yet — scores need at least one to be meaningful.`);
    return;
  }

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 5);
  const bottom = sorted.slice(-5).reverse();

  const fmt = (r: (typeof sorted)[number]) => `\`${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}\`: *${r.score.toFixed(0)}/100* (${r.tradesWithOutcome} trades)`;

  await sendTelegramMessageTo(
    chatId,
    `🏆 *Wallet Credibility*\n\nTop:\n${top.map(fmt).join("\n")}\n\nBottom:\n${bottom.map(fmt).join("\n")}\n\n_Full evidence: \`npm run wallet-scores\`._`
  );
}

async function handleScan(chatId: string, address: string | undefined): Promise<void> {
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    await sendTelegramMessageTo(chatId, "Usage: `/scan <token mint address>`");
    return;
  }

  await sendTelegramMessageTo(chatId, `🔍 Scanning \`${address}\` in real-time...`);

  const [pairs, authorities, topHolder] = await Promise.all([
    fetchTokenPairs(address).catch(() => []),
    checkMintAuthorities(address).catch(() => null),
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
  const liq = pair.liquidity?.usd ? `$${Math.round(pair.liquidity.usd).toLocaleString()}` : "Unknown";
  const vol24h = pair.volume?.h24 ? `$${Math.round(pair.volume.h24).toLocaleString()}` : "Unknown";
  const price = pair.priceUsd ? `$${pair.priceUsd}` : "Unknown";
  const fdv = pair.fdv ? `$${Math.round(pair.fdv).toLocaleString()}` : "Unknown";

  let securityText = "";
  if (authorities) {
    const mintIcon = authorities.mintAuthorityRenounced ? "✅" : "⚠️";
    const mintText = authorities.mintAuthorityRenounced ? "Renounced" : "*NOT RENOUNCED (can mint)*";
    const freezeIcon = authorities.freezeAuthorityRenounced ? "✅" : "⚠️";
    const freezeText = authorities.freezeAuthorityRenounced ? "Renounced" : "*NOT RENOUNCED (can freeze)*";
    securityText += `\nMint Authority: ${mintIcon} ${mintText}\nFreeze Authority: ${freezeIcon} ${freezeText}`;
  }
  if (topHolder !== null) {
    securityText += `\nTop 1 Holder: ${topHolder > 20 ? "⚠️" : "✅"} ~${topHolder.toFixed(1)}% of top-20 sample`;
  }

  const text =
    `🔬 *Token Security & Market Scan*\n\n` +
    `*${pair.baseToken.name} ($${pair.baseToken.symbol})*\n` +
    `CA: \`${address}\`\n\n` +
    `💰 Price: *${price}* | FDV: *${fdv}*\n` +
    `💧 Liquidity: *${liq}* | 24h Vol: *${vol24h}*\n` +
    `DEX: *${pair.dexId}*` +
    `${securityText}\n\n` +
    `⚡ *Trade instantly using the terminals below:*`;

  const imageUrl = getTokenImageUrl(address, pair);
  await sendTelegramPhotoTo(chatId, imageUrl, text, getTokenTradingButtons(address));
}

async function handleTrending(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🔥 Fetching live trending Solana tokens...");
  const boosted = await fetchLatestBoostedSolanaTokens().catch(() => []);
  if (boosted.length === 0) {
    await sendTelegramMessageTo(chatId, "No trending tokens returned right now — try again in a minute.");
    return;
  }

  const top5 = boosted.slice(0, 5);
  let text = `🔥 *Top Trending Solana Tokens (DexScreener Live)*\n\n`;
  for (let i = 0; i < top5.length; i++) {
    const t = top5[i];
    text += `${i + 1}. \`${t.tokenAddress}\`\n`;
  }
  text += `\n_Use /scan <address> for full security audit or tap any quick-trade button._`;

  const buttons = top5.slice(0, 3).map((t) => [
    { text: `⚡ Photon (${t.tokenAddress.slice(0, 4)}...)`, url: `https://photon-sol.tinyastro.io/en/lp/${t.tokenAddress}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${t.tokenAddress}` },
    { text: `📊 DexS`, url: `https://dexscreener.com/solana/${t.tokenAddress}` },
  ]);

  await sendTelegramMessageTo(chatId, text, buttons);
}

async function handleDiscover(chatId: string): Promise<void> {
  await sendTelegramMessageTo(chatId, "🔄 Running wallet auto-discovery pass now...");
  try {
    const res = await runDiscoveryOnce();
    await sendTelegramMessageTo(chatId, `✅ Discovery complete! Added *${res.added}* new smart-money wallet(s) to Helius webhook.`);
  } catch (err) {
    await sendTelegramMessageTo(chatId, `Discovery run encountered an issue: ${(err as Error).message}`);
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
          `👋 Onchain intelligence bot online.\nReal-time Helius tracking active. See /help for instant commands.`
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
        await handleList(chatId);
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
    await sendTelegramMessageTo(chatId, "Something went wrong handling that command — check the server logs.");
  }
}

