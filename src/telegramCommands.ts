/**
 * TELEGRAM SLASH COMMANDS — /watch, /unwatch, /list, /status, /scores,
 * /help. Received via a Telegram webhook (see server.ts's
 * /webhooks/telegram endpoint), separate from the Helius webhook that
 * drives the actual signal detection.
 *
 * Every command here does exactly what the equivalent manual action
 * would do (insert/delete a row, run the same query a report script
 * runs) — nothing here bypasses the evidence/validation rules the rest
 * of the bot follows. /watch adds a wallet the same way a manual seed
 * would; it doesn't create a shortcut around anything.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessageTo } from "./telegram.js";
import { refreshWebhookWithCurrentWallets } from "./discover.js";
import { computeAllWalletScores } from "./walletScoring.js";

// Loose but real validation: base58, correct length range for a Solana
// address. Not a guarantee the address is valid, just enough to catch
// obvious typos before we insert garbage into tracked_wallets.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

const HELP_TEXT =
  `🤖 *Onchain Intelligence Bot — Commands*\n\n` +
  `/watch <wallet address> — start tracking a wallet\n` +
  `/unwatch <wallet address> — stop tracking a wallet\n` +
  `/list — show how many wallets are tracked (and a few examples)\n` +
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
  await sendTelegramMessageTo(chatId, `✅ Now tracking \`${address}\`. Webhook updated — you'll get alerts on its future activity.`);
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
  await sendTelegramMessageTo(chatId, `✅ Stopped tracking \`${address}\`. Webhook updated.`);
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
          `👋 Onchain intelligence bot online. Everything it sends is \`[UNVALIDATED]\` until paper trading proves otherwise — see /help for what you can do.`
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
      default:
        // Not a recognized command — say nothing rather than noise the
        // chat on every non-command message people send.
        break;
    }
  } catch (err) {
    console.error("[telegramCommands] command handling failed:", (err as Error).message);
    await sendTelegramMessageTo(chatId, "Something went wrong handling that command — check the server logs.");
  }
}
