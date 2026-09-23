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

async function rawSendPhoto(chatId: string, photoUrl: string, captionText: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — logging instead of sending:\n", captionText);
    return;
  }

  const replyMarkup = buttons
    ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }
    : undefined;

  // Telegram caption limit is 1024 characters.
  const caption = captionText.length > 1024 ? captionText.slice(0, 1020) + "..." : captionText;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: "Markdown",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });

    if (!res.ok) {
      console.warn(`[telegram] sendPhoto returned ${res.status}, falling back to sendMessage`);
      await rawSend(chatId, captionText, buttons);
    }
  } catch (err) {
    console.warn("[telegram] sendPhoto error, falling back to sendMessage:", (err as Error).message);
    await rawSend(chatId, captionText, buttons);
  }
}

/**
 * Sends to the configured default chat (TELEGRAM_CHAT_ID) — used by automated alerts.
 */
export async function sendTelegramMessage(text: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!DEFAULT_CHAT_ID) {
    console.warn("[telegram] TELEGRAM_CHAT_ID not set — logging instead of sending:\n", text);
    return;
  }
  await rawSend(DEFAULT_CHAT_ID, text, buttons);
}

/**
 * Sends a message with a photo to the default chat. Falls back to text message if photo fails.
 */
export async function sendTelegramPhoto(photoUrl: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!DEFAULT_CHAT_ID) {
    console.warn("[telegram] TELEGRAM_CHAT_ID not set — logging instead of sending:\n", text);
    return;
  }
  await rawSendPhoto(DEFAULT_CHAT_ID, photoUrl, text, buttons);
}

/**
 * Sends to a SPECIFIC chat — used when replying to an inbound slash command.
 */
export async function sendTelegramMessageTo(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  await rawSend(chatId, text, buttons);
}

/**
 * Sends a photo message to a SPECIFIC chat. Falls back to text message if photo fails.
 */
export async function sendTelegramPhotoTo(chatId: string, photoUrl: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  await rawSendPhoto(chatId, photoUrl, text, buttons);
}

