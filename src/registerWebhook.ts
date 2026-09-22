/**
 * Creates (first run) or updates (subsequent runs) the single Helius
 * webhook this bot uses, pointing it at every address currently in
 * `tracked_wallets`. Run this manually whenever you add wallets by hand,
 * and it's also called by discover.ts after auto-expansion — but batched
 * (once per discovery run, not once per new wallet), since editing a
 * webhook costs 100 Helius credits per call.
 *
 * Usage:
 *   HELIUS_API_KEY=... HELIUS_WEBHOOK_SECRET=... WEBHOOK_URL=https://your-app.onrender.com/webhooks/helius \
 *     npm run register-webhook
 *
 * The webhook ID it creates gets printed — save it as HELIUS_WEBHOOK_ID
 * in your env so future runs update instead of creating duplicates.
 */
import { supabase } from "./supabase.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com/webhooks/helius
const EXISTING_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID; // set after first run

if (!HELIUS_API_KEY || !WEBHOOK_SECRET || !WEBHOOK_URL) {
  console.error("Missing HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET, or WEBHOOK_URL env var.");
  process.exit(1);
}

async function main() {
  const { data, error } = await supabase.from("tracked_wallets").select("address");
  if (error) throw error;
  const addresses = (data ?? []).map((r) => r.address);

  if (addresses.length === 0) {
    console.error("No tracked wallets in Supabase yet — seed some (e.g. from wallets.json) before registering the webhook.");
    process.exit(1);
  }

  const body = {
    webhookURL: WEBHOOK_URL,
    transactionTypes: ["SWAP"],
    accountAddresses: addresses,
    webhookType: "enhanced",
    authHeader: WEBHOOK_SECRET,
  };

  const url = EXISTING_WEBHOOK_ID
    ? `https://api.helius.xyz/v0/webhooks/${EXISTING_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`
    : `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  const method = EXISTING_WEBHOOK_ID ? "PUT" : "POST";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`Helius API error ${res.status}:`, await res.text());
    process.exit(1);
  }

  const result = await res.json();
  console.log(`${EXISTING_WEBHOOK_ID ? "Updated" : "Created"} webhook covering ${addresses.length} address(es).`);
  if (!EXISTING_WEBHOOK_ID) {
    console.log(`Webhook ID: ${result.webhookID}`);
    console.log(`Save this as HELIUS_WEBHOOK_ID so future runs update it instead of creating a new one.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
