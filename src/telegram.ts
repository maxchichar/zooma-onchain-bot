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
  if (DEFAULT_CHAT_ID && DEFAULT_CHAT_ID !== "8653623689") {
    ids.add(DEFAULT_CHAT_ID);
  }
  for (const id of activeChatIds) {
    if (id !== "8653623689") {
      ids.add(id);
    }
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

const DEFAULT_LOCAL_BANNER = path.resolve(process.cwd(), "assets/zooma_logo.png");

async function sendPhotoViaFormData(
  chatId: string,
  buffer: Buffer | Uint8Array,
  filename: string,
  caption?: string,
  replyMarkup?: any
): Promise<Response> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", new Blob([buffer as any], { type: "image/jpeg" }), filename);
  if (caption) {
    formData.append("caption", caption);
    formData.append("parse_mode", "Markdown");
  }
  if (replyMarkup) {
    formData.append("reply_markup", JSON.stringify(replyMarkup));
  }

  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: formData,
  });
}

async function rawSendPhoto(chatId: string, photoSource: string, captionText: string, buttons?: TelegramButton[][]): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set, logging caption:\n", captionText);
    return;
  }

  const replyMarkup = buttons
    ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }
    : undefined;

  const localPath = fs.existsSync(photoSource)
    ? photoSource
    : path.resolve(process.cwd(), photoSource);
  const isLocalFile = fs.existsSync(localPath);

  // If caption is too long for Telegram (limit 1024), send photo with first line, then full text
  const isCaptionTooLong = captionText.length > 1020;
  const photoCaption = isCaptionTooLong ? captionText.split("\n")[0] : captionText;

  try {
    if (isLocalFile) {
      const fileBuffer = fs.readFileSync(localPath);
      const filename = path.basename(localPath);
      const res = await sendPhotoViaFormData(
        chatId,
        fileBuffer,
        filename,
        photoCaption,
        !isCaptionTooLong ? replyMarkup : undefined
      );
      if (res.ok) {
        if (isCaptionTooLong) await rawSend(chatId, captionText, buttons);
        return;
      }
    } else {
      // Remote image URL: fetch binary directly to bypass Telegram CDN fetch errors
      try {
        const imgRes = await fetch(photoSource, { signal: AbortSignal.timeout(2500) });
        if (imgRes.ok) {
          const arrayBuffer = await imgRes.arrayBuffer();
          if (arrayBuffer.byteLength > 0) {
            const res = await sendPhotoViaFormData(
              chatId,
              new Uint8Array(arrayBuffer),
              "token.jpg",
              photoCaption,
              !isCaptionTooLong ? replyMarkup : undefined
            );
            if (res.ok) {
              if (isCaptionTooLong) await rawSend(chatId, captionText, buttons);
              return;
            }
          }
        }
      } catch {
        // remote fetch timed out or failed, try direct Telegram URL method
      }

      // Try passing URL directly to Telegram sendPhoto API
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photoSource,
          ...(photoCaption ? { caption: photoCaption, parse_mode: "Markdown" } : {}),
          ...((!isCaptionTooLong && replyMarkup) ? { reply_markup: replyMarkup } : {}),
        }),
      });

      if (res.ok) {
        if (isCaptionTooLong) await rawSend(chatId, captionText, buttons);
        return;
      }
    }

    // High reliability fallback: send official local ZOOMA banner photo
    if (fs.existsSync(DEFAULT_LOCAL_BANNER)) {
      const bannerBuffer = fs.readFileSync(DEFAULT_LOCAL_BANNER);
      const res = await sendPhotoViaFormData(
        chatId,
        bannerBuffer,
        "zooma_logo.png",
        photoCaption,
        !isCaptionTooLong ? replyMarkup : undefined
      );
      if (res.ok) {
        if (isCaptionTooLong) await rawSend(chatId, captionText, buttons);
        return;
      }
    }

    // Final fallback to text message if photo delivery failed completely
    await rawSend(chatId, captionText, buttons);
  } catch (err) {
    console.warn("[telegram] sendPhoto error, attempting local banner fallback:", (err as Error).message);
    try {
      if (fs.existsSync(DEFAULT_LOCAL_BANNER)) {
        const bannerBuffer = fs.readFileSync(DEFAULT_LOCAL_BANNER);
        const res = await sendPhotoViaFormData(chatId, bannerBuffer, "zooma_logo.png", photoCaption, replyMarkup);
        if (res.ok) return;
      }
    } catch {
      // ignore
    }
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
