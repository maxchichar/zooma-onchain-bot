/**
 * Registers the Telegram webhook so the bot receives slash commands
 * (/watch, /unwatch, /list, /status, /scores, /help). Run once after
 * deploying, and again if your Render URL ever changes.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *   WEBHOOK_URL=https://your-app.onrender.com/webhooks/telegram \
 *     npm run register-telegram-webhook
 *
 * TELEGRAM_WEBHOOK_SECRET can be any random string you invent — Telegram
 * echoes it back in every request's X-Telegram-Bot-Api-Secret-Token
 * header so the server can verify a request actually came from Telegram.
 * Use a DIFFERENT value than HELIUS_WEBHOOK_SECRET (they're unrelated).
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !WEBHOOK_URL) {
  console.error("Missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, or WEBHOOK_URL env var.");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"],
    }),
  });

  const result = await res.json();
  if (!res.ok || !result.ok) {
    console.error("Failed to set Telegram webhook:", result);
    process.exit(1);
  }

  console.log(`Telegram webhook registered at ${WEBHOOK_URL}`);
  console.log("Test it by messaging your bot /help on Telegram.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
