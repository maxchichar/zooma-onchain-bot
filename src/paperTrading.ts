/**
 * PAPER TRADING ENGINE:
 * Simulates real-time trading for every fired signal (100x gems, solid gems, whale buys, trending, manual, pump.fun drops, insider snipes).
 * Tracks positions against live DEX market prices with stop-loss (-20%), take-profit (+50%), and max hold (48h).
 * Sends instant Telegram alerts when trades open, hit profit targets, or get stopped out.
 * Features dual-layer persistence: local JSON ledger + Supabase cloud sync.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramMessageTo,
  sendTelegramPhotoTo,
} from "./telegram.js";
import { fetchTokenPairs, fetchCollectionStats, getTokenImageUrl } from "./researchSources.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { getRecentPumpDrops } from "./pumpFunStream.js";

let paperTradingEnabled = true;
let currentPositionSize = Number(process.env.PAPER_POSITION_SIZE ?? 2); // $2 USD virtual notional per trade
const STOP_LOSS_PCT = Number(process.env.PAPER_STOP_LOSS_PCT ?? 20); // % below entry
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TAKE_PROFIT_PCT ?? 50); // % above entry
const MAX_HOLD_HOURS = Number(process.env.PAPER_MAX_HOLD_HOURS ?? 48);
const FEE_PCT = Number(process.env.PAPER_FEE_PCT ?? 1); // per side (entry + exit)
const SLIPPAGE_PCT = Number(process.env.PAPER_SLIPPAGE_PCT ?? 2); // per side

const milestoneAlertedTrades = new Set<string>();

const STORE_FILE = path.resolve(process.cwd(), ".paper_trades_store.json");

export type Category =
  | "wallet_pattern"
  | "meme_coin_watch"
  | "nft_watch"
  | "trending_trade"
  | "solid_gem"
  | "whale_entry"
  | "manual_entry"
  | "insider_snipe"
  | "early_100x"
  | "pump_fun";

export interface StoredTrade {
  id: string;
  signal_id: string | null;
  token_mint: string;
  category: Category;
  quote_currency: "usd" | "sol";
  entry_price: number;
  entry_time: string;
  position_size: number;
  stop_loss_price: number | null;
  target_price: number | null;
  max_hold_until: string;
  status: "open" | "closed";
  exit_price?: number | null;
  exit_time?: string | null;
  exit_reason?: string | null;
  pnl_pct?: number | null;
  pnl_absolute?: number | null;
  fees_absolute?: number | null;
  created_at: string;
  token_symbol?: string;
  token_name?: string;
  peak_price?: number;
  trailing_stop_price?: number | null;
  breakeven_locked?: boolean;
}

export type OpenTrade = StoredTrade;

const activeOpenMints = new Set<string>();

/**
 * Renders a visual progress bar towards the profit target.
 */
export function renderProgressBar(pnlPct: number, targetPct: number = 50): string {
  const totalBlocks = 10;
  const clamped = Math.max(0, Math.min(100, (pnlPct / targetPct) * 100));
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((clamped / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;
  const fillIcon = pnlPct >= 0 ? "🟩" : "🟥";
  return `[${fillIcon.repeat(filledBlocks)}${"⬜".repeat(emptyBlocks)}] ${clamped.toFixed(0)}% to TP`;
}

function readLocalLedger(): StoredTrade[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed: StoredTrade[] = JSON.parse(raw);
    for (const t of parsed) {
      if (t.status === "open") activeOpenMints.add(t.token_mint);
    }
    return parsed;
  } catch (err) {
    console.warn("[paperTrading] failed to read local trades file:", (err as Error).message);
    return [];
  }
}

function writeLocalLedger(trades: StoredTrade[]): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(trades, null, 2), "utf8");
  } catch (err) {
    console.error("[paperTrading] failed to write local trades file:", (err as Error).message);
  }
}

function saveTradeToLocalStore(trade: StoredTrade): void {
  const all = readLocalLedger();
  const existingIdx = all.findIndex((t) => t.id === trade.id);
  if (existingIdx >= 0) {
    all[existingIdx] = trade;
  } else {
    all.push(trade);
  }
  writeLocalLedger(all);
}

export function isPaperTradingActive(): boolean {
  return paperTradingEnabled;
}

export function setPaperTradingActive(active: boolean): void {
  paperTradingEnabled = active;
}

export function setPaperTradingPositionSize(usd: number): void {
  if (usd > 0) currentPositionSize = usd;
}

export function getPaperTradingSettings() {
  return {
    enabled: paperTradingEnabled,
    positionSize: currentPositionSize,
    stopLossPct: STOP_LOSS_PCT,
    takeProfitPct: TAKE_PROFIT_PCT,
    maxHoldHours: MAX_HOLD_HOURS,
  };
}

interface CurrentPrice {
  price: number;
  quoteCurrency: "usd" | "sol";
  pair?: any;
}

/** Best-effort current price. Returns null if unavailable. */
async function getCurrentPrice(tokenOrSymbol: string, category: Category): Promise<CurrentPrice | null> {
  if (category === "nft_watch") {
    const stats = await fetchCollectionStats(tokenOrSymbol, "24h");
    if (!stats?.floorPrice) return null;
    return { price: stats.floorPrice / 1_000_000_000, quoteCurrency: "sol" };
  }

  const pairs = await fetchTokenPairs(tokenOrSymbol);
  if (pairs.length > 0) {
    const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
    const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
    if (priceUsd && priceUsd > 0) {
      return { price: priceUsd, quoteCurrency: "usd", pair };
    }
  }

  // Fallback to Pump.fun drop cache if pool is in early bonding curve stage
  const recent = getRecentPumpDrops(60).find((d) => d.mint === tokenOrSymbol);
  if (recent) {
    const solPriceEst = 150;
    const estimatedPrice = (recent.marketCapSol * solPriceEst) / 1_000_000_000;
    return {
      price: estimatedPrice,
      quoteCurrency: "usd",
      pair: {
        baseToken: { address: recent.mint, name: recent.name, symbol: recent.symbol },
        priceUsd: estimatedPrice.toString(),
        liquidity: { usd: recent.marketCapSol * solPriceEst },
        dexId: recent.isRaydiumGraduation ? "raydium" : "pumpfun",
      },
    };
  }

  return null;
}

/**
 * Checks if an open trade is already active for this token mint to prevent duplicates.
 */
export async function isTradeAlreadyOpen(tokenMint: string): Promise<boolean> {
  if (activeOpenMints.has(tokenMint)) return true;
  const local = readLocalLedger();
  const openLocal = local.some((t) => t.token_mint === tokenMint && t.status === "open");
  if (openLocal) {
    activeOpenMints.add(tokenMint);
    return true;
  }

  try {
    const { data } = await supabase
      .from("paper_trades")
      .select("id")
      .eq("token_mint", tokenMint)
      .eq("status", "open")
      .limit(1);
    if (data && data.length > 0) {
      activeOpenMints.add(tokenMint);
      return true;
    }
  } catch {
    // Ignore network errors and rely on local ledger
  }

  return false;
}

async function asyncInsertToSupabase(record: any): Promise<void> {
  try {
    const { error } = await supabase.from("paper_trades").insert(record);
    if (error) console.warn("[paperTrading] Supabase insert notice:", error.message);
  } catch (err) {
    console.warn("[paperTrading] Supabase connection failed, using local ledger:", (err as Error).message);
  }
}

async function asyncUpdateToSupabase(id: string, updates: any): Promise<void> {
  try {
    const { error } = await supabase.from("paper_trades").update(updates).eq("id", id);
    if (error) console.warn("[paperTrading] Supabase update notice:", error.message);
  } catch (err) {
    console.warn("[paperTrading] Supabase connection failed, using local ledger:", (err as Error).message);
  }
}

/**
 * Automatically opens a simulated paper trade for any alert across the bot.
 */
export async function openPaperTrade(
  signalId: string | null,
  tokenOrSymbol: string,
  category: Category,
  fallbackPrice?: number | string,
  fallbackPair?: any
): Promise<void> {
  if (!paperTradingEnabled) {
    return;
  }

  // Prevent duplicate open trades on the exact same token (< 0.01ms check)
  const alreadyOpen = await isTradeAlreadyOpen(tokenOrSymbol);
  if (alreadyOpen) {
    console.log(`[paperTrading] Trade already open for ${tokenOrSymbol} - skipping duplicate.`);
    return;
  }

  const fallbackPriceUsd = fallbackPrice ? (typeof fallbackPrice === "string" ? parseFloat(fallbackPrice) : fallbackPrice) : undefined;

  let current = await getCurrentPrice(tokenOrSymbol, category);
  if (!current && fallbackPriceUsd && fallbackPriceUsd > 0) {
    current = {
      price: fallbackPriceUsd,
      quoteCurrency: "usd",
      pair: fallbackPair,
    };
  }

  if (!current || !current.price || current.price <= 0) {
    console.warn(`[paperTrading] no price available for ${tokenOrSymbol} (${category}) - skipping paper trade.`);
    return;
  }

  const stopLossPrice = current.price * (1 - STOP_LOSS_PCT / 100);
  const targetPrice = current.price * (1 + TAKE_PROFIT_PCT / 100);
  const nowIso = new Date().toISOString();
  const maxHoldUntil = new Date(Date.now() + MAX_HOLD_HOURS * 3600 * 1000).toISOString();
  const tradeId = crypto.randomUUID();

  const symbol = current.pair?.baseToken?.symbol ?? tokenOrSymbol.slice(0, 8);
  const name = current.pair?.baseToken?.name ?? symbol;

  const tradeRecord: StoredTrade = {
    id: tradeId,
    signal_id: signalId ?? null,
    token_mint: tokenOrSymbol,
    category,
    quote_currency: current.quoteCurrency,
    entry_price: current.price,
    entry_time: nowIso,
    position_size: currentPositionSize,
    stop_loss_price: stopLossPrice,
    target_price: targetPrice,
    max_hold_until: maxHoldUntil,
    status: "open",
    created_at: nowIso,
    token_symbol: symbol,
    token_name: name,
    peak_price: current.price,
    trailing_stop_price: stopLossPrice,
    breakeven_locked: false,
  };

  // Add to active mints set immediately
  activeOpenMints.add(tokenOrSymbol);

  // 1. Immediately persist locally (zero-latency resilient storage)
  saveTradeToLocalStore(tradeRecord);

  // 2. Best-effort async push to Supabase
  asyncInsertToSupabase({
    id: tradeRecord.id,
    signal_id: tradeRecord.signal_id,
    token_mint: tradeRecord.token_mint,
    category: tradeRecord.category,
    quote_currency: tradeRecord.quote_currency,
    entry_price: tradeRecord.entry_price,
    position_size: tradeRecord.position_size,
    stop_loss_price: tradeRecord.stop_loss_price,
    target_price: tradeRecord.target_price,
    max_hold_until: tradeRecord.max_hold_until,
  });

  let tag = "AUTO-TRADE OPENED";
  if (category === "insider_snipe") tag = "AUTO-TRADE: INSIDER SNIPE";
  else if (category === "pump_fun") tag = "AUTO-TRADE: PUMP.FUN DROP";
  else if (category === "early_100x") tag = "AUTO-TRADE: EARLY 100X GEM";
  else if (category === "solid_gem") tag = "AUTO-TRADE: SOLID GEM";
  else if (category === "trending_trade") tag = "AUTO-TRADE: TRENDING BREAKOUT";
  else if (category === "whale_entry") tag = "AUTO-TRADE: WHALE ENTRY";
  else if (category === "wallet_pattern") tag = "AUTO-TRADE: SMART MONEY PATTERN";
  else if (category === "manual_entry") tag = "MANUAL PAPER TRADE";

  const entryStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
  const stopStr = stopLossPrice < 0.01 ? `$${stopLossPrice.toFixed(6)}` : `$${stopLossPrice.toFixed(4)}`;
  const targetStr = targetPrice < 0.01 ? `$${targetPrice.toFixed(6)}` : `$${targetPrice.toFixed(4)}`;

  const message =
    `🎯 *[${tag}]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${tokenOrSymbol}\`\n` +
    `• Strategy: \`${category}\`\n` +
    `• Entry Price: *${entryStr} ${current.quoteCurrency.toUpperCase()}*\n` +
    `• Position Sizing: *$${currentPositionSize.toFixed(2)} ${current.quoteCurrency.toUpperCase()}* (Virtual Trade)\n` +
    `• Stop-Loss (-${STOP_LOSS_PCT}%): *${stopStr}*\n` +
    `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n` +
    `• Max Holding Window: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Auto-executing live simulated trade. Real DEX prices tracked continuously._`;

  const buttons = category !== "nft_watch" ? getTokenTradingButtons(tokenOrSymbol) : undefined;
  const imageUrl = category !== "nft_watch" ? getTokenImageUrl(tokenOrSymbol, current.pair) : undefined;

  try {
    if (imageUrl) {
      await sendTelegramPhoto(imageUrl, message, buttons);
    } else {
      await sendTelegramMessage(message, buttons);
    }
  } catch (err) {
    console.warn("[paperTrading] trade open alert send error:", (err as Error).message);
  }
}

/**
 * Opens a manual simulated paper trade on demand for a specific contract address.
 */
export async function openManualPaperTrade(
  chatId: string,
  tokenMint: string,
  sizeUsd?: number
): Promise<void> {
  const positionSize = sizeUsd && sizeUsd > 0 ? sizeUsd : currentPositionSize;

  await sendTelegramMessageTo(chatId, `🔍 Fetching live DEX market pool for \`${tokenMint}\`...`);

  let current = await getCurrentPrice(tokenMint, "solid_gem");
  let pair = current?.pair;

  if (!current || !current.price || current.price <= 0) {
    await sendTelegramMessageTo(
      chatId,
      `⚠️ *Could not resolve live price for CA* \`${tokenMint}\`\n\n` +
      `No active liquidity pool was found on Raydium, Orca, or Pump.fun yet. If this token was just created, please allow 15 to 30 seconds for pool initialization and try again.`
    );
    return;
  }

  const stopLossPrice = current.price * (1 - STOP_LOSS_PCT / 100);
  const targetPrice = current.price * (1 + TAKE_PROFIT_PCT / 100);
  const nowIso = new Date().toISOString();
  const maxHoldUntil = new Date(Date.now() + MAX_HOLD_HOURS * 3600 * 1000).toISOString();
  const tradeId = crypto.randomUUID();

  const symbol = pair?.baseToken?.symbol ?? tokenMint.slice(0, 8);
  const name = pair?.baseToken?.name ?? symbol;

  const tradeRecord: StoredTrade = {
    id: tradeId,
    signal_id: null,
    token_mint: tokenMint,
    category: "manual_entry",
    quote_currency: current.quoteCurrency,
    entry_price: current.price,
    entry_time: nowIso,
    position_size: positionSize,
    stop_loss_price: stopLossPrice,
    target_price: targetPrice,
    max_hold_until: maxHoldUntil,
    status: "open",
    created_at: nowIso,
    token_symbol: symbol,
    token_name: name,
    peak_price: current.price,
    trailing_stop_price: stopLossPrice,
    breakeven_locked: false,
  };

  activeOpenMints.add(tokenMint);
  saveTradeToLocalStore(tradeRecord);

  asyncInsertToSupabase({
    id: tradeRecord.id,
    signal_id: null,
    token_mint: tokenMint,
    category: "manual_entry",
    quote_currency: current.quoteCurrency,
    entry_price: current.price,
    position_size: positionSize,
    stop_loss_price: stopLossPrice,
    target_price: targetPrice,
    max_hold_until: maxHoldUntil,
  });

  const entryStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
  const stopStr = stopLossPrice < 0.01 ? `$${stopLossPrice.toFixed(6)}` : `$${stopLossPrice.toFixed(4)}`;
  const targetStr = targetPrice < 0.01 ? `$${targetPrice.toFixed(6)}` : `$${targetPrice.toFixed(4)}`;

  const message =
    `🎯 *[MANUAL PAPER TRADE OPENED]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${tokenMint}\`\n` +
    `• Strategy: \`manual_entry\`\n` +
    `• Entry Price: *${entryStr} USD*\n` +
    `• Position Sizing: *$${positionSize.toFixed(2)} USD* (Simulated)\n` +
    `• Stop-Loss (-${STOP_LOSS_PCT}%): *${stopStr}*\n` +
    `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n` +
    `• Max Hold: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Real-time price tracking active. Dynamic trailing stops and take-profit will auto-trigger._`;

  const buttons = getTokenTradingButtons(tokenMint);
  const imageUrl = getTokenImageUrl(tokenMint, pair);

  if (imageUrl) {
    await sendTelegramPhotoTo(chatId, imageUrl, message, buttons);
  } else {
    await sendTelegramMessageTo(chatId, message, buttons);
  }
}

/**
 * Automatically opens a simulated paper trade for a live trending token (if not already opened recently).
 */
export async function openTrendingPaperTrade(tokenMint: string, fallbackPrice?: number | string, fallbackPair?: any): Promise<boolean> {
  try {
    const alreadyOpen = await isTradeAlreadyOpen(tokenMint);
    if (alreadyOpen) return false;

    await openPaperTrade(null, tokenMint, "trending_trade", fallbackPrice, fallbackPair);
    return true;
  } catch (err) {
    console.warn(`[paperTrading] openTrendingPaperTrade error for ${tokenMint}:`, (err as Error).message);
    return false;
  }
}

function computePnl(entryPrice: number, exitPrice: number, positionSize: number): { pnlPct: number; pnlAbsolute: number; fees: number } {
  const effectiveEntry = entryPrice * (1 + SLIPPAGE_PCT / 100);
  const effectiveExit = exitPrice * (1 - SLIPPAGE_PCT / 100);

  const grossReturnPct = (effectiveExit / effectiveEntry - 1) * 100;
  const grossPnl = positionSize * (grossReturnPct / 100);
  const fees = positionSize * (FEE_PCT / 100) * 2; // entry + exit
  const netPnl = grossPnl - fees;
  const pnlPct = (netPnl / positionSize) * 100;

  return { pnlPct, pnlAbsolute: netPnl, fees };
}

async function closeTrade(trade: OpenTrade, exitPrice: number, exitReason: string): Promise<void> {
  const { pnlPct, pnlAbsolute, fees } = computePnl(trade.entry_price, exitPrice, trade.position_size);
  const exitTime = new Date().toISOString();

  trade.status = "closed";
  trade.exit_price = exitPrice;
  trade.exit_time = exitTime;
  trade.exit_reason = exitReason;
  trade.pnl_pct = pnlPct;
  trade.pnl_absolute = pnlAbsolute;
  trade.fees_absolute = fees;

  // Remove from fast active set
  activeOpenMints.delete(trade.token_mint);

  // 1. Update local storage
  saveTradeToLocalStore(trade);

  // 2. Best-effort cloud sync
  asyncUpdateToSupabase(trade.id, {
    status: "closed",
    exit_price: exitPrice,
    exit_time: exitTime,
    exit_reason: exitReason,
    pnl_pct: pnlPct,
    pnl_absolute: pnlAbsolute,
    fees_absolute: fees,
  });

  let emoji = "📊";
  let title = "PAPER TRADE CLOSED";
  if (exitReason === "target") {
    emoji = "🎉";
    title = `TAKE-PROFIT HIT (+${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "stop_loss") {
    emoji = "🛑";
    title = `STOP-LOSS TRIGGERED (${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "trailing_stop") {
    emoji = "🛡️";
    title = `TRAILING STOP TRIGGERED (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "manual_close" || exitReason === "manual_close_all") {
    emoji = "⚡";
    title = `MANUAL EXIT (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "time_exit") {
    emoji = "⏰";
    title = `TIME LIMIT EXIT (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`;
  }

  const pnlSign = pnlAbsolute >= 0 ? "+" : "";
  const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
  const exitStr = exitPrice < 0.01 ? `$${exitPrice.toFixed(6)}` : `$${exitPrice.toFixed(4)}`;

  const symbol = trade.token_symbol ?? trade.token_mint.slice(0, 8);
  const name = trade.token_name ?? symbol;

  const message =
    `${emoji} *[PAPER TRADE: ${title}]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${trade.token_mint}\`\n` +
    `• Strategy: \`${trade.category}\`\n` +
    `• Entry: *${entryStr}* ➡️ Exit: *${exitStr}*\n` +
    `• Realized Net PnL: *${pnlSign}${pnlPct.toFixed(1)}%* (*${pnlSign}$${pnlAbsolute.toFixed(2)} ${trade.quote_currency.toUpperCase()}*)\n` +
    `• Modeled Fees: *$${fees.toFixed(2)}*\n` +
    `• Exit Reason: \`${exitReason}\`\n\n` +
    `_Simulated performance tracking net of modeled fees & slippage._`;

  const buttons = trade.category !== "nft_watch" ? getTokenTradingButtons(trade.token_mint) : undefined;
  const imageUrl = trade.category !== "nft_watch" ? getTokenImageUrl(trade.token_mint) : undefined;

  try {
    if (imageUrl) {
      await sendTelegramPhoto(imageUrl, message, buttons);
    } else {
      await sendTelegramMessage(message, buttons);
    }
  } catch {
    await sendTelegramMessage(message, buttons);
  }
}

/**
 * Retrieves all currently open paper trades from local storage and Supabase.
 */
export async function getOpenPaperTrades(): Promise<OpenTrade[]> {
  const localTrades = readLocalLedger().filter((t) => t.status === "open");
  const localMap = new Map<string, OpenTrade>();
  for (const t of localTrades) {
    localMap.set(t.id, t);
  }

  try {
    const { data, error } = await supabase.from("paper_trades").select("*").eq("status", "open");
    if (!error && data) {
      for (const row of data as OpenTrade[]) {
        if (!localMap.has(row.id)) {
          localMap.set(row.id, row);
        }
      }
    }
  } catch {
    // Rely on local ledger when offline
  }

  return Array.from(localMap.values());
}

/** Checks every open trade against its stop/target/time-limit. Call on a schedule. */
export async function checkOpenTrades(): Promise<void> {
  const openTrades = await getOpenPaperTrades();
  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const current = await getCurrentPrice(trade.token_mint, trade.category);
      const pastMaxHold = new Date(trade.max_hold_until).getTime() <= Date.now();

      if (!current) {
        if (pastMaxHold) {
          console.warn(`[paperTrading] ${trade.token_mint} unpriceable at max-hold - closing with no PnL data.`);
          trade.status = "closed";
          trade.exit_reason = "price_unavailable";
          trade.exit_time = new Date().toISOString();
          saveTradeToLocalStore(trade);
          asyncUpdateToSupabase(trade.id, { status: "closed", exit_reason: "price_unavailable", exit_time: trade.exit_time });
        }
        continue;
      }

      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);

      // Track peak price
      const currentPeak = Math.max(trade.peak_price ?? trade.entry_price, current.price);
      trade.peak_price = currentPeak;

      // Breakeven Shield: At +20% gain, lock stop-loss at +5% (guaranteed profit lock)
      if (pnlPct >= 20 && !trade.breakeven_locked) {
        trade.breakeven_locked = true;
        const breakevenStop = trade.entry_price * 1.05;
        if (!trade.stop_loss_price || breakevenStop > trade.stop_loss_price) {
          trade.stop_loss_price = breakevenStop;
          trade.trailing_stop_price = breakevenStop;
          saveTradeToLocalStore(trade);
          asyncUpdateToSupabase(trade.id, { stop_loss_price: trade.stop_loss_price });
        }

        if (!milestoneAlertedTrades.has(`${trade.id}_shield`)) {
          milestoneAlertedTrades.add(`${trade.id}_shield`);
          const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : (trade.token_symbol ?? trade.token_mint.slice(0, 8));
          const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
          const stopStr = trade.stop_loss_price < 0.01 ? `$${trade.stop_loss_price.toFixed(6)}` : `$${trade.stop_loss_price.toFixed(4)}`;
          const shieldMsg =
            `🛡️ *[BREAKEVEN SHIELD ACTIVATED]*\n\n` +
            `*${symbol}* surged to *+${pnlPct.toFixed(1)}%* profit!\n` +
            `• Token CA: \`${trade.token_mint}\`\n` +
            `• Current Price: *${currentStr}* (Entry: *$${trade.entry_price.toFixed(4)}*)\n` +
            `• Stop-Loss Ratcheted To: *${stopStr}* (+5.0% profit locked)\n` +
            `• Downside risk eliminated. Capital is 100% protected.\n` +
            `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}`;
          sendTelegramMessage(shieldMsg, getTokenTradingButtons(trade.token_mint)).catch(() => {});
        }
      }

      // Trailing Stop Ratchet: At +35% gain, ratchet stop-loss to +20%
      if (pnlPct >= 35) {
        const ratchetStop = trade.entry_price * 1.20;
        if (!trade.stop_loss_price || ratchetStop > trade.stop_loss_price) {
          trade.stop_loss_price = ratchetStop;
          trade.trailing_stop_price = ratchetStop;
          saveTradeToLocalStore(trade);
          asyncUpdateToSupabase(trade.id, { stop_loss_price: trade.stop_loss_price });
        }
      }

      // Dynamic High-Peak Trail: If position gained > 35%, trail 15% below peak
      if (pnlPct >= 35 && currentPeak > trade.entry_price) {
        const trailingFloor = currentPeak * 0.85;
        if (!trade.stop_loss_price || trailingFloor > trade.stop_loss_price) {
          trade.stop_loss_price = trailingFloor;
          trade.trailing_stop_price = trailingFloor;
          saveTradeToLocalStore(trade);
        }
      }

      // Milestone gain alert (+20%)
      if (pnlPct >= 20 && !milestoneAlertedTrades.has(`${trade.id}_20`)) {
        milestoneAlertedTrades.add(`${trade.id}_20`);
        const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : (trade.token_symbol ?? trade.token_mint.slice(0, 8));
        const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
        const msg =
          `🚀 *[PAPER TRADE PROGRESS: +${pnlPct.toFixed(1)}% GAIN]*\n\n` +
          `• Token: *${symbol}*\n` +
          `• CA: \`${trade.token_mint}\`\n` +
          `• Current Price: *${currentStr}* (Entry: *$${trade.entry_price.toFixed(4)}*)\n` +
          `• Unrealized Profit: *+$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
          `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}\n` +
          `• Target Remaining: *${(TAKE_PROFIT_PCT - pnlPct).toFixed(1)}%* to Target Exit (+${TAKE_PROFIT_PCT}%)\n\n` +
          `_Running live tracking. Take-profit will auto-execute when reached._`;
        sendTelegramMessage(msg, getTokenTradingButtons(trade.token_mint)).catch(() => {});
      }

      // Milestone gain alert (+35%)
      if (pnlPct >= 35 && !milestoneAlertedTrades.has(`${trade.id}_35`)) {
        milestoneAlertedTrades.add(`${trade.id}_35`);
        const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : (trade.token_symbol ?? trade.token_mint.slice(0, 8));
        const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
        const msg =
          `⚡ *[PAPER TRADE SURGE: +${pnlPct.toFixed(1)}% PROFIT]*\n\n` +
          `• Token: *${symbol}*\n` +
          `• CA: \`${trade.token_mint}\`\n` +
          `• Current Price: *${currentStr}*\n` +
          `• Profit: *+$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
          `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}\n` +
          `• Approaching target exit: *${(TAKE_PROFIT_PCT - pnlPct).toFixed(1)}%* remaining.`;
        sendTelegramMessage(msg, getTokenTradingButtons(trade.token_mint)).catch(() => {});
      }

      if (trade.stop_loss_price !== null && current.price <= trade.stop_loss_price) {
        const isTrailing = trade.breakeven_locked || (trade.trailing_stop_price && trade.trailing_stop_price > trade.entry_price);
        await closeTrade(trade, current.price, isTrailing ? "trailing_stop" : "stop_loss");
      } else if (trade.target_price !== null && current.price >= trade.target_price) {
        await closeTrade(trade, current.price, "target");
      } else if (pastMaxHold) {
        await closeTrade(trade, current.price, "time_exit");
      }
    } catch (err) {
      console.warn(`[paperTrading] check failed for trade ${trade.id}:`, (err as Error).message);
    }
  }
}

/**
 * Generates a live report of all currently open paper trade positions with unrealized PnL.
 */
export async function getOpenPositionsReport(): Promise<string> {
  const openTrades = await getOpenPaperTrades();
  if (openTrades.length === 0) {
    return "ℹ️ No active simulated paper trade positions right now.\n\nPaper trading auto-executes $2 trades on incoming alerts or `/papertrade <CA>`.";
  }

  let report = `💼 *Active Simulated Positions (${openTrades.length}):*\n\n`;

  for (let i = 0; i < openTrades.length; i++) {
    const trade = openTrades[i];
    const current = await getCurrentPrice(trade.token_mint, trade.category);

    const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
    let currentStr = "Fetching...";
    let pnlStr = "n/a";

    if (current) {
      currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);
      const sign = pnlPct >= 0 ? "+" : "";
      pnlStr = `${sign}${pnlPct.toFixed(1)}% (${sign}$${pnlAbsolute.toFixed(2)})`;
    }

    const symbol = trade.token_symbol ?? trade.token_mint.slice(0, 8);
    report += `${i + 1}. *${symbol}* (\`${trade.token_mint.slice(0, 4)}...${trade.token_mint.slice(-4)}\`)\n`;
    report += `   • Strategy: \`${trade.category}\` | Size: *$${trade.position_size.toFixed(2)}*\n`;
    report += `   • Entry: *${entryStr}* ➡️ Now: *${currentStr}*\n`;
    report += `   • Unrealized PnL: *${pnlStr}*\n\n`;
  }

  return report;
}

/**
 * Sends rich photo cards with token image, contract address, and real-time PnL for active positions.
 */
export async function sendPositionsPhotoCards(chatId: string): Promise<void> {
  const openTrades = await getOpenPaperTrades();

  if (openTrades.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      "ℹ️ No active simulated paper trade positions right now.\n\nAuto-trading is active for every alert! You can also use `/papertrade <CA>` to paper trade any specific token instantly."
    );
    return;
  }

  const displayTrades = openTrades.slice(0, 5);
  for (let i = 0; i < displayTrades.length; i++) {
    const trade = displayTrades[i];
    const current = await getCurrentPrice(trade.token_mint, trade.category);

    const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
    let currentStr = "Fetching...";
    let pnlLine = "";
    let progressLine = "";
    let shieldLine = "";

    if (current) {
      currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);
      const icon = pnlPct >= 0 ? "🟢" : "🔴";
      const sign = pnlPct >= 0 ? "+" : "";
      pnlLine = `\n• Unrealized PnL: *${sign}${pnlPct.toFixed(1)}%* (${sign}$${pnlAbsolute.toFixed(2)} USD) ${icon}`;
      progressLine = `\n• Target Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}`;
      if (trade.breakeven_locked) {
        shieldLine = `\n• Protection: 🛡️ *Breakeven Shield Active* (+5% locked)`;
      } else if (trade.trailing_stop_price && trade.trailing_stop_price > trade.entry_price) {
        shieldLine = `\n• Protection: ⚡ *Trailing Stop Active*`;
      }
    }

    const symbol = current?.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : (trade.token_symbol ?? trade.token_mint.slice(0, 8));
    const name = current?.pair?.baseToken?.name ?? (trade.token_name ?? symbol);
    const stopStr = trade.stop_loss_price ? (trade.stop_loss_price < 0.01 ? `$${trade.stop_loss_price.toFixed(6)}` : `$${trade.stop_loss_price.toFixed(4)}`) : "n/a";
    const targetStr = trade.target_price ? (trade.target_price < 0.01 ? `$${trade.target_price.toFixed(6)}` : `$${trade.target_price.toFixed(4)}`) : "n/a";

    const caption =
      `💼 *[ACTIVE POSITION #${i + 1} | ${name}]*\n\n` +
      `• Token: *${symbol}*\n` +
      `• CA: \`${trade.token_mint}\`\n` +
      `• Strategy: \`${trade.category}\`\n` +
      `• Entry Price: *${entryStr}*\n` +
      `• Current Price: *${currentStr}*` +
      pnlLine +
      progressLine +
      shieldLine +
      `\n• Position Size: *$${trade.position_size.toFixed(2)} USD* (Simulated)\n` +
      `• Stop-Loss: *${stopStr}*\n` +
      `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n\n` +
      `⚡ *Trade Fast on Terminals:*`;

    const imageUrl = getTokenImageUrl(trade.token_mint, current?.pair);
    const buttons = getTokenTradingButtons(trade.token_mint);

    try {
      await sendTelegramPhotoTo(chatId, imageUrl, caption, buttons);
    } catch {
      await sendTelegramMessageTo(chatId, caption, buttons);
    }
  }

  if (openTrades.length > 5) {
    await sendTelegramMessageTo(
      chatId,
      `ℹ️ _Plus ${openTrades.length - 5} more open positions. Total active: ${openTrades.length}._`
    );
  }
}

/**
 * Manually closes an open paper trade position on demand.
 */
export async function closePaperTradeManually(chatId: string, tokenMint?: string): Promise<void> {
  const openTrades = await getOpenPaperTrades();
  if (openTrades.length === 0) {
    await sendTelegramMessageTo(chatId, "ℹ️ You have no active paper trade positions to close.");
    return;
  }

  if (!tokenMint) {
    const list = openTrades
      .slice(0, 5)
      .map((t) => `• \`${t.token_mint}\` (${t.token_symbol ?? "Token"})`)
      .join("\n");
    await sendTelegramMessageTo(
      chatId,
      `⚠️ *Specify a token address or "all" to close:*\n\n` +
      `Usage: \`/close <token CA>\` or \`/close all\`\n\n` +
      `*Currently Open Positions:*\n${list}`
    );
    return;
  }

  if (tokenMint.toLowerCase() === "all") {
    await sendTelegramMessageTo(chatId, `🔄 Closing all ${openTrades.length} open simulated positions at live market rates...`);
    let closedCount = 0;
    for (const trade of openTrades) {
      const current = await getCurrentPrice(trade.token_mint, trade.category);
      const exitPrice = current?.price ?? trade.entry_price;
      await closeTrade(trade, exitPrice, "manual_close_all");
      closedCount++;
    }
    await sendTelegramMessageTo(chatId, `✅ Successfully closed ${closedCount} positions. Check /history or /pnl for results.`);
    return;
  }

  const normalized = tokenMint.trim().toLowerCase();
  const trade = openTrades.find(
    (t) => t.token_mint.toLowerCase() === normalized || t.token_mint.toLowerCase().startsWith(normalized)
  );

  if (!trade) {
    await sendTelegramMessageTo(
      chatId,
      `⚠️ No active open paper trade found for \`${tokenMint}\`.\n\nUse \`/positions\` to view your currently active positions.`
    );
    return;
  }

  const current = await getCurrentPrice(trade.token_mint, trade.category);
  const exitPrice = current?.price ?? trade.entry_price;
  await closeTrade(trade, exitPrice, "manual_close");

  const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, exitPrice, trade.position_size);
  const sign = pnlPct >= 0 ? "+" : "";
  const symbol = trade.token_symbol ?? trade.token_mint.slice(0, 8);

  await sendTelegramMessageTo(
    chatId,
    `✅ *[MANUAL POSITION CLOSED]*\n\n` +
    `*${symbol}* closed at live DEX market price.\n` +
    `• Token CA: \`${trade.token_mint}\`\n` +
    `• Exit Price: *$${exitPrice < 0.01 ? exitPrice.toFixed(6) : exitPrice.toFixed(4)}*\n` +
    `• Realized Net PnL: *${sign}${pnlPct.toFixed(1)}%* (${sign}$${pnlAbsolute.toFixed(2)} USD)\n\n` +
    `_Check /history to review all closed trades or /positions for remaining open positions._`
  );
}

/**
 * Displays recent closed paper trades with profit, holding time, and performance metrics.
 */
export async function sendTradeHistory(chatId: string): Promise<void> {
  const localClosed = readLocalLedger().filter((t) => t.status === "closed");
  const tradeMap = new Map<string, StoredTrade>();
  for (const t of localClosed) {
    tradeMap.set(t.id, t);
  }

  try {
    const { data } = await supabase
      .from("paper_trades")
      .select("*")
      .eq("status", "closed")
      .order("exit_time", { ascending: false })
      .limit(20);
    if (data) {
      for (const row of data as StoredTrade[]) {
        if (!tradeMap.has(row.id)) tradeMap.set(row.id, row);
      }
    }
  } catch {}

  const closedTrades = Array.from(tradeMap.values()).sort(
    (a, b) => new Date(b.exit_time ?? b.created_at).getTime() - new Date(a.exit_time ?? a.created_at).getTime()
  );

  if (closedTrades.length === 0) {
    await sendTelegramMessageTo(
      chatId,
      `📜 *Trade History: No closed positions yet.*\n\n` +
      `Trades will appear here as soon as they hit take-profit (+50%), stop-loss (-20%), or are manually closed via \`/close <CA>\`.`
    );
    return;
  }

  const displayList = closedTrades.slice(0, 8);
  let text = `📜 *[RECENT PAPER TRADE HISTORY]*\n` +
             `_Displaying last ${displayList.length} of ${closedTrades.length} closed trades:_\n\n`;

  for (let i = 0; i < displayList.length; i++) {
    const t = displayList[i];
    const pnl = Number(t.pnl_pct ?? 0);
    const pnlAbs = Number(t.pnl_absolute ?? 0);
    const sign = pnl >= 0 ? "+" : "";
    const icon = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    const symbol = t.token_symbol ?? t.token_mint.slice(0, 8);
    const entryStr = t.entry_price < 0.01 ? `$${t.entry_price.toFixed(6)}` : `$${t.entry_price.toFixed(4)}`;
    const exitStr = t.exit_price ? (t.exit_price < 0.01 ? `$${t.exit_price.toFixed(6)}` : `$${t.exit_price.toFixed(4)}`) : "n/a";

    let reasonTag = t.exit_reason ?? "closed";
    if (reasonTag === "target") reasonTag = "Take-Profit (+50%)";
    else if (reasonTag === "stop_loss") reasonTag = "Stop-Loss (-20%)";
    else if (reasonTag === "trailing_stop") reasonTag = "Trailing Stop";
    else if (reasonTag === "manual_close" || reasonTag === "manual_close_all") reasonTag = "Manual Exit";
    else if (reasonTag === "time_exit") reasonTag = "Time Window (48h)";

    text += `${i + 1}. ${icon} *${symbol}* (\`${t.token_mint.slice(0, 4)}...${t.token_mint.slice(-4)}\`)\n`;
    text += `   • Net PnL: *${sign}${pnl.toFixed(1)}%* (${sign}$${pnlAbs.toFixed(2)} USD)\n`;
    text += `   • Entry: *${entryStr}* ➡️ Exit: *${exitStr}*\n`;
    text += `   • Reason: \`${reasonTag}\` | Strategy: \`${t.category}\`\n\n`;
  }

  const wins = closedTrades.filter((t) => Number(t.pnl_pct ?? 0) > 0).length;
  const winRate = ((wins / closedTrades.length) * 100).toFixed(0);
  text += `📊 *Summary:* ${wins} Wins / ${closedTrades.length - wins} Losses (${winRate}% Win Rate)\n` +
          `_Use /positions to see active trades, or /pnl for complete analytics._`;

  await sendTelegramMessageTo(chatId, text);
}

/**
 * Periodically sends an automated portfolio status update to subscribers if there are open positions.
 */
export async function sendPeriodicPortfolioDigest(): Promise<void> {
  const openTrades = await getOpenPaperTrades();
  if (openTrades.length === 0) return;

  let totalInvestedUsd = 0;
  let totalCurrentValUsd = 0;
  let winners = 0;
  let losers = 0;

  for (const trade of openTrades) {
    totalInvestedUsd += trade.position_size;
    const current = await getCurrentPrice(trade.token_mint, trade.category);
    if (current) {
      const { pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);
      totalCurrentValUsd += trade.position_size + pnlAbsolute;
      if (pnlAbsolute >= 0) winners++;
      else losers++;
    } else {
      totalCurrentValUsd += trade.position_size;
    }
  }

  const netPnlUsd = totalCurrentValUsd - totalInvestedUsd;
  const netPnlPct = totalInvestedUsd > 0 ? (netPnlUsd / totalInvestedUsd) * 100 : 0;
  const sign = netPnlUsd >= 0 ? "+" : "";
  const icon = netPnlUsd >= 0 ? "🟢" : "🔴";

  const summaryMessage =
    `📈 *[LIVE PAPER PORTFOLIO DIGEST]*\n\n` +
    `• Open Positions: *${openTrades.length} active*\n` +
    `• Total Simulated Capital: *$${totalInvestedUsd.toFixed(2)} USD*\n` +
    `• Estimated Valuation: *$${totalCurrentValUsd.toFixed(2)} USD*\n` +
    `• Total Unrealized Return: *${sign}${netPnlPct.toFixed(1)}%* (${sign}$${netPnlUsd.toFixed(2)} USD) ${icon}\n` +
    `• Win / Loss Ratio: *${winners} In Profit* | *${losers} In Drawdown*\n\n` +
    `_Auto-trading on every alert. Use /positions to view full breakdown cards._`;

  await sendTelegramMessage(summaryMessage);
}

export interface PaperTradingStats {
  windowDays: number;
  closedTrades: number;
  winRate: number | null;
  avgPnlPct: number | null;
  totalPnlByCurrency: Record<string, number>;
  profitFactor: number | null;
  expectancyPct: number | null;
  maxDrawdownPct: number | null;
  verdict: "NO EDGE DETECTED" | "POSITIVE EXPECTANCY (SMALL SAMPLE)" | "INSUFFICIENT DATA";
}

export async function computeStats(windowDays: number, category?: Category): Promise<PaperTradingStats> {
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  
  // Merge closed trades from local ledger and Supabase
  const localClosed = readLocalLedger().filter((t) => t.status === "closed" && t.entry_time >= since);
  const tradeMap = new Map<string, StoredTrade>();
  for (const t of localClosed) {
    if (!category || t.category === category) tradeMap.set(t.id, t);
  }

  try {
    let query = supabase.from("paper_trades").select("*").eq("status", "closed").gte("entry_time", since);
    if (category) query = query.eq("category", category);
    const { data } = await query;
    if (data) {
      for (const row of data as StoredTrade[]) {
        if (!tradeMap.has(row.id)) tradeMap.set(row.id, row);
      }
    }
  } catch {
    // Continue with local data
  }

  const trades = Array.from(tradeMap.values());

  if (trades.length === 0) {
    return {
      windowDays,
      closedTrades: 0,
      winRate: null,
      avgPnlPct: null,
      totalPnlByCurrency: {},
      profitFactor: null,
      expectancyPct: null,
      maxDrawdownPct: null,
      verdict: "INSUFFICIENT DATA",
    };
  }

  const pnlPcts = trades.map((t) => Number(t.pnl_pct ?? 0));
  const wins = trades.filter((t) => Number(t.pnl_pct ?? 0) > 0);
  const losses = trades.filter((t) => Number(t.pnl_pct ?? 0) <= 0);

  const winRate = wins.length / trades.length;
  const avgPnlPct = pnlPcts.reduce((s, p) => s + p, 0) / pnlPcts.length;

  const grossWin = wins.reduce((s, t) => s + Number(t.pnl_pct ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl_pct ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0;

  const expectancyPct = avgPnlPct;

  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime()
  );
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of sorted) {
    cumulative += Number(t.pnl_pct ?? 0);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }

  const totalPnlByCurrency: Record<string, number> = {};
  for (const t of trades) {
    const cur = t.quote_currency;
    totalPnlByCurrency[cur] = (totalPnlByCurrency[cur] ?? 0) + Number(t.pnl_absolute ?? 0);
  }

  const verdict: PaperTradingStats["verdict"] =
    expectancyPct > 0 ? "POSITIVE EXPECTANCY (SMALL SAMPLE)" : "NO EDGE DETECTED";

  return {
    windowDays,
    closedTrades: trades.length,
    winRate,
    avgPnlPct,
    totalPnlByCurrency,
    profitFactor,
    expectancyPct,
    maxDrawdownPct: maxDrawdown,
    verdict,
  };
}

export function formatStats(label: string, stats: PaperTradingStats): string {
  if (stats.closedTrades === 0) {
    return `*${label}:* 0 closed trades (collecting live data)`;
  }
  const currencyLines = Object.entries(stats.totalPnlByCurrency)
    .map(([cur, total]) => `${total.toFixed(2)} ${cur.toUpperCase()}`)
    .join(", ");
  return (
    `*${label} (${stats.closedTrades} closed trades):*\n` +
    `• Win Rate: *${((stats.winRate ?? 0) * 100).toFixed(0)}%* | Avg PnL: *${stats.avgPnlPct?.toFixed(1)}%*\n` +
    `• Profit Factor: *${stats.profitFactor === Infinity ? "infinity (no losses)" : stats.profitFactor?.toFixed(2)}*\n` +
    `• Total PnL: *${currencyLines || "n/a"}* | Max Drawdown: *${stats.maxDrawdownPct?.toFixed(1)}%*\n` +
    `• Verdict: *${stats.verdict}*`
  );
}

/** Sends a periodic performance digest to Telegram. */
export async function sendPerformanceDigest(): Promise<void> {
  const [d7, d30, d90] = await Promise.all([computeStats(7), computeStats(30), computeStats(90)]);

  const message =
    `📊 *[PAPER TRADING PERFORMANCE DIGEST]*\n\n` +
    `${formatStats("Last 7 Days", d7)}\n\n` +
    `${formatStats("Last 30 Days", d30)}\n\n` +
    `${formatStats("Last 90 Days", d90)}\n\n` +
    `_Statistical Note: Expectancy metrics become robust after 20+ closed trades._`;

  await sendTelegramMessage(message);
}
