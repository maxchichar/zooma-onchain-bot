const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export interface TelegramButton {
  text: string;
  url: string;
}

async function rawSend(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — logging instead of sending:\n", text);
    return;
  }

  const replyMarkup = buttons
    ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }
    : undefined;

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] send failed: ${res.status} ${body}`);
  }
}

/**
 * Sends to the configured default chat (TELEGRAM_CHAT_ID) — used by every
 * automated alert (signals, paper trades, digests). Every message this
 * bot sends automatically should be prefixed with a status tag
 * ([UNVALIDATED] until backtesting says otherwise) — see signalEngine.ts
 * for where that's enforced. This function itself doesn't add the tag;
 * it just delivers whatever text (and optional buttons) it's given.
 */
export async function sendTelegramMessage(text: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!DEFAULT_CHAT_ID) {
    console.warn("[telegram] TELEGRAM_CHAT_ID not set — logging instead of sending:\n", text);
    return;
  }
  await rawSend(DEFAULT_CHAT_ID, text, buttons);
}

/**
 * Sends to a SPECIFIC chat — used only when replying to an inbound slash
 * command (telegramCommands.ts), where the reply should go back to
 * whoever sent the command, not necessarily the default chat.
 */
export async function sendTelegramMessageTo(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  await rawSend(chatId, text, buttons);
}
