import fs from "fs";
import path from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ACTIVE_CHATS_FILE = path.resolve(process.cwd(), ".active_chats.json");

const activeChatIds = new Set<string>();

function loadActiveChats(): void {
  try {
    if (fs.existsSync(ACTIVE_CHATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACTIVE_CHATS_FILE, "utf8"));
      if (Array.isArray(data)) {
        data.forEach((id) => {
          if (id) activeChatIds.add(String(id));
        });
      }
    }
  } catch (err) {
    console.warn("[telegram] failed to read active chats file:", (err as Error).message);
  }
}

function saveActiveChats(): void {
  try {
    fs.writeFileSync(ACTIVE_CHATS_FILE, JSON.stringify(Array.from(activeChatIds)), "utf8");
  } catch (err) {
    console.warn("[telegram] failed to save active chats file:", (err as Error).message);
  }
}

loadActiveChats();

export interface TelegramButton {
  text: string;
  url: string;
}

export function registerActiveChat(chatId: string): void {
  if (!chatId) return;
  if (!activeChatIds.has(chatId)) {
    activeChatIds.add(chatId);
    saveActiveChats();
    console.log(`[telegram] registered active subscriber chat: ${chatId}. Total chats: ${activeChatIds.size}`);
  }
}

export function getBroadcastChatIds(): string[] {
  const ids = new Set<string>();
  if (DEFAULT_CHAT_ID) {
    ids.add(DEFAULT_CHAT_ID);
  }
  for (const id of activeChatIds) {
    ids.add(id);
  }
  return Array.from(ids);
}

async function rawSend(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set, logging message:\n", text);
    return;
  }

  const replyMarkup = buttons
    ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }
    : undefined;

  try {
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
      console.error(`[telegram] send failed to ${chatId}: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error(`[telegram] send error to ${chatId}:`, (err as Error).message);
  }
}

async function rawSendPhoto(chatId: string, photoSource: string, captionText: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set, logging caption:\n", captionText);
    return;
  }

  const replyMarkup = buttons
    ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }
    : undefined;

  const caption = captionText.length > 1024 ? captionText.slice(0, 1020) + "..." : captionText;

  try {
    let res: Response;
    if (fs.existsSync(photoSource)) {
      const fileBuffer = fs.readFileSync(photoSource);
      const filename = path.basename(photoSource);
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("photo", new Blob([fileBuffer], { type: "image/jpeg" }), filename);
      formData.append("caption", caption);
      formData.append("parse_mode", "Markdown");
      if (replyMarkup) {
        formData.append("reply_markup", JSON.stringify(replyMarkup));
      }

      res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        body: formData,
      });
    } else {
      res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photoSource,
          caption: caption,
          parse_mode: "Markdown",
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });
    }

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
 * Sends to all registered subscriber chats (and TELEGRAM_CHAT_ID) for automated background alerts.
 */
export async function sendTelegramMessage(text: string, buttons?: TelegramButton[][]): Promise<void> {
  const chatIds = getBroadcastChatIds();
  if (chatIds.length === 0) {
    console.warn("[telegram] no chat IDs configured or registered, logging alert:\n", text);
    return;
  }
  await Promise.all(chatIds.map((id) => rawSend(id, text, buttons)));
}

/**
 * Sends a photo message to all registered subscriber chats. Falls back to text message if photo fails.
 */
export async function sendTelegramPhoto(photoUrl: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  const chatIds = getBroadcastChatIds();
  if (chatIds.length === 0) {
    console.warn("[telegram] no chat IDs configured or registered, logging photo alert:\n", text);
    return;
  }
  await Promise.all(chatIds.map((id) => rawSendPhoto(id, photoUrl, text, buttons)));
}

/**
 * Sends to a specific chat when replying to an inbound command.
 */
export async function sendTelegramMessageTo(chatId: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  registerActiveChat(chatId);
  await rawSend(chatId, text, buttons);
}

/**
 * Sends a photo message to a specific chat.
 */
export async function sendTelegramPhotoTo(chatId: string, photoUrl: string, text: string, buttons?: TelegramButton[][]): Promise<void> {
  registerActiveChat(chatId);
  await rawSendPhoto(chatId, photoUrl, text, buttons);
}
