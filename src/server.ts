import express from "express";
import { supabase } from "./supabase.js";
import { processTransaction } from "./signalEngine.js";
import { runDiscoveryOnce } from "./discover.js";
import { runResearchOnce } from "./research.js";
import { checkOpenTrades, sendPerformanceDigest } from "./paperTrading.js";
import { sendWalletScoreDigest } from "./walletScoring.js";
import { sendResearchScoreDigest } from "./researchScoring.js";
import { handleTelegramUpdate } from "./telegramCommands.js";
import { HeliusEnhancedTx } from "./types.js";

const app = express();
app.use(express.json({ limit: "5mb" })); // webhook batches can be sizeable

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;

// In-memory cache of tracked wallets, refreshed periodically so we don't
// hit the DB on every single incoming transaction. Falls back to a DB
// query on first request if the cache hasn't warmed up yet.
let trackedWalletsCache = new Set<string>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

async function loadTrackedWallets(): Promise<Set<string>> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && trackedWalletsCache.size > 0) {
    return trackedWalletsCache;
  }
  const { data, error } = await supabase.from("tracked_wallets").select("address");
  if (error) {
    console.error("[server] failed to refresh tracked wallets, using stale cache:", error.message);
    return trackedWalletsCache;
  }
  trackedWalletsCache = new Set((data ?? []).map((r) => r.address));
  cacheLoadedAt = Date.now();
  return trackedWalletsCache;
}

// ---------- Keep-alive target ----------
// Point an external free pinger (cron-job.org, UptimeRobot) at GET /health
// every ~10 minutes. Render's free tier spins down after ~15 minutes of no
// inbound traffic, so this is what keeps webhooks from being missed while
// the service is asleep. See README.md for the honest caveats on this.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime_seconds: process.uptime() });
});

// ---------- Helius webhook receiver ----------
app.post("/webhooks/helius", async (req, res) => {
  // Verify this actually came from Helius, not a random POST to a guessed URL.
  const authHeader = req.header("Authorization");
  if (!WEBHOOK_SECRET || authHeader !== WEBHOOK_SECRET) {
    console.warn("[server] rejected webhook call with missing/invalid auth header");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Helius enhanced webhooks POST an array of parsed transactions.
  const txs = req.body as HeliusEnhancedTx[];
  if (!Array.isArray(txs)) {
    res.status(400).json({ error: "expected an array of transactions" });
    return;
  }

  // Acknowledge immediately, then process — Helius retries on non-2xx and
  // on timeout, and we don't want a slow DB round-trip to cause duplicate
  // deliveries. Processing is idempotent (dedup on signature+wallet) so
  // even a retry that slips through is harmless.
  res.status(200).json({ received: txs.length });

  try {
    const trackedWallets = await loadTrackedWallets();
    for (const tx of txs) {
      await processTransaction(tx, trackedWallets);
    }
  } catch (err) {
    console.error("[server] error processing webhook batch:", err);
  }
});

// ---------- Telegram slash command receiver ----------
// Separate from the Helius webhook above — different sender, different
// auth mechanism (Telegram's own secret-token header, set via
// setWebhook's secret_token param, not an Authorization header).
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

app.post("/webhooks/telegram", async (req, res) => {
  const secretHeader = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!TELEGRAM_WEBHOOK_SECRET || secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    console.warn("[server] rejected Telegram webhook call with missing/invalid secret token");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  res.status(200).json({ ok: true }); // ack immediately, same reasoning as the Helius endpoint

  try {
    await handleTelegramUpdate(req.body);
  } catch (err) {
    console.error("[server] error handling Telegram update:", err);
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
  loadTrackedWallets().then((w) => {
    console.log(`[server] tracking ${w.size} wallet(s) in real-time`);
    // Kick off an initial discovery and research pass immediately on boot (non-blocking)
    runDiscoveryOnce().catch((err) => console.error("[server] initial discovery error:", err));
    runResearchOnce().catch((err) => console.error("[server] initial research error:", err));
  });
});

// ---------- In-process discovery scheduler ----------
// Runs inside the same always-on process instead of a separate GitHub
// Actions cron. This is the "maximize" path: it isn't bound by GitHub's
// free-minute budget or scheduling delays, and can run as often as you
// want. runDiscoveryOnce() itself enforces MAX_TRACKED_WALLETS, so
// running this frequently is safe — it just becomes a no-op once you hit
// the cap you've set, rather than something that needs separate throttling
// here.
const DISCOVERY_INTERVAL_MINUTES = Number(process.env.DISCOVERY_INTERVAL_MINUTES ?? 5);
let discoveryInFlight = false;

setInterval(async () => {
  if (discoveryInFlight) return; // don't overlap runs if one is still working
  discoveryInFlight = true;
  try {
    await runDiscoveryOnce();
    // Wallet list may have grown — force the webhook-address cache to
    // refresh on the next incoming transaction rather than waiting out
    // the full TTL.
    cacheLoadedAt = 0;
  } catch (err) {
    console.error("[server] scheduled discovery run failed:", err);
  } finally {
    discoveryInFlight = false;
  }
}, DISCOVERY_INTERVAL_MINUTES * 60 * 1000);

// ---------- In-process research scheduler (meme coins, NFTs) ----------
// Separate from wallet-pattern discovery above — different data sources
// (DexScreener/LunarCrush/Magic Eden, not Helius), different cadence.
const RESEARCH_INTERVAL_MINUTES = Number(process.env.RESEARCH_INTERVAL_MINUTES ?? 15);
let researchInFlight = false;

setInterval(async () => {
  if (researchInFlight) return;
  researchInFlight = true;
  try {
    await runResearchOnce();
  } catch (err) {
    console.error("[server] scheduled research run failed:", err);
  } finally {
    researchInFlight = false;
  }
}, RESEARCH_INTERVAL_MINUTES * 60 * 1000);

// ---------- In-process paper-trading scheduler ----------
// Checks open simulated positions against stop/target/time-limit, and
// periodically sends a performance digest. This is the module that
// actually tells you whether any of this is working.
const PAPER_CHECK_INTERVAL_MINUTES = Number(process.env.PAPER_CHECK_INTERVAL_MINUTES ?? 10);
const PAPER_DIGEST_INTERVAL_HOURS = Number(process.env.PAPER_DIGEST_INTERVAL_HOURS ?? 24);
let paperCheckInFlight = false;

setInterval(async () => {
  if (paperCheckInFlight) return;
  paperCheckInFlight = true;
  try {
    await checkOpenTrades();
  } catch (err) {
    console.error("[server] paper trade check failed:", err);
  } finally {
    paperCheckInFlight = false;
  }
}, PAPER_CHECK_INTERVAL_MINUTES * 60 * 1000);

setInterval(async () => {
  try {
    await sendPerformanceDigest();
  } catch (err) {
    console.error("[server] performance digest failed:", err);
  }
}, PAPER_DIGEST_INTERVAL_HOURS * 3600 * 1000);

// ---------- In-process wallet credibility scoring ----------
// Weekly by default — this depends on paper trades having closed, which
// itself takes time, so there's no benefit to running it more often
// early on. Fully deterministic, no JEV/LLM in the scoring math itself.
const WALLET_SCORE_INTERVAL_HOURS = Number(process.env.WALLET_SCORE_INTERVAL_HOURS ?? 168);

setInterval(async () => {
  try {
    await sendWalletScoreDigest();
  } catch (err) {
    console.error("[server] wallet score digest failed:", err);
  }
}, WALLET_SCORE_INTERVAL_HOURS * 3600 * 1000);

// ---------- In-process research signal scoring ----------
// Same cadence as wallet scoring, same reason (depends on paper trades
// having closed). Checks whether JEV's risk read is actually calibrated
// for meme coins/NFTs — a distinct question from wallet credibility,
// since tokens/collections aren't reusable entities the way wallets are.
setInterval(async () => {
  try {
    await sendResearchScoreDigest();
  } catch (err) {
    console.error("[server] research score digest failed:", err);
  }
}, WALLET_SCORE_INTERVAL_HOURS * 3600 * 1000);
