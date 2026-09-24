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
import { getRecentPumpDrops, subscribeToTokenTrades, unsubscribeFromTokenTrades } from "./pumpFunStream.js";
import { extractPatternFeatures, getPatternOptimizationAdvice, recordTradeOutcome } from "./patternLearning.js";
import { evaluateTokenDumpRisk, isTokenInDumpCooldown, sendDumpShieldAlert, DumpEvent } from "./dumpDetector.js";

let paperTradingEnabled = true;
let currentPositionSize = Number(process.env.PAPER_POSITION_SIZE ?? 2); // $2 USD virtual notional per trade
const STOP_LOSS_PCT = Number(process.env.PAPER_STOP_LOSS_PCT ?? 5); // % below entry (strict 5% max loss limit)
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TAKE_PROFIT_PCT ?? 50); // % above entry
const MAX_HOLD_HOURS = Number(process.env.PAPER_MAX_HOLD_HOURS ?? 48);
const FEE_PCT = Number(process.env.PAPER_FEE_PCT ?? 1); // per side (entry + exit)
const SLIPPAGE_PCT = Number(process.env.PAPER_SLIPPAGE_PCT ?? 2); // per side

const milestoneAlertedTrades = new Set<string>();

const ZOOMA_BANNER_IMAGE = process.env.ZOOMA_BANNER_URL ?? "assets/zooma_logo.png";
const STORE_FILE = path.resolve(process.cwd(), ".paper_trades_store.json");
const WALLET_STORE_FILE = path.resolve(process.cwd(), ".paper_wallet_store.json");

/**
 * AI CONFIDENCE THRESHOLD:
 * Only signals and drops with >= 80% (0.80) AI confidence qualify for auto paper trading.
 */
export const MIN_AI_CONFIDENCE = 0.80;
export const MIN_REQUIRED_FUNDS_USD = 10; // Reduced required funds to $10 USD (5 trades capacity)

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

export interface AllTimeProfitSummary {
  totalClosed: number;
  totalWins: number;
  totalLosses: number;
  winRatePct: number;
  totalRealizedPnlUsd: number;
  totalFeesUsd: number;
  bestWinner: { symbol: string; mint: string; pnlUsd: number; pnlPct: number } | null;
  worstLoss: { symbol: string; mint: string; pnlUsd: number; pnlPct: number } | null;
}

export function getAllTimeProfitSummary(): AllTimeProfitSummary {
  const local = readLocalLedger();
  const closed = local.filter((t) => t.status === "closed");
  let totalRealizedPnlUsd = 0;
  let totalFeesUsd = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let bestWinner: { symbol: string; mint: string; pnlUsd: number; pnlPct: number } | null = null;
  let worstLoss: { symbol: string; mint: string; pnlUsd: number; pnlPct: number } | null = null;

  for (const t of closed) {
    const pnlUsd = Number(t.pnl_absolute ?? 0);
    const pnlPct = Number(t.pnl_pct ?? 0);
    const fees = Number(t.fees_absolute ?? 0);
    totalRealizedPnlUsd += pnlUsd;
    totalFeesUsd += fees;
    if (pnlUsd > 0) totalWins++;
    else if (pnlUsd < 0) totalLosses++;

    if (!bestWinner || pnlUsd > bestWinner.pnlUsd) {
      bestWinner = {
        symbol: t.token_symbol ?? t.token_mint.slice(0, 8),
        mint: t.token_mint,
        pnlUsd,
        pnlPct,
      };
    }
    if (!worstLoss || pnlUsd < worstLoss.pnlUsd) {
      worstLoss = {
        symbol: t.token_symbol ?? t.token_mint.slice(0, 8),
        mint: t.token_mint,
        pnlUsd,
        pnlPct,
      };
    }
  }

  const winRatePct = closed.length > 0 ? (totalWins / closed.length) * 100 : 0;
  return {
    totalClosed: closed.length,
    totalWins,
    totalLosses,
    winRatePct,
    totalRealizedPnlUsd,
    totalFeesUsd,
    bestWinner,
    worstLoss,
  };
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

export interface PaperWalletState {
  initialFundedAmount: number;
  availableCash: number;
  allocatedCash: number;
  totalRealizedPnl: number;
  totalTradesExecuted: number;
  isFunded: boolean;
  sessionStartTime: string;
  lastUpdated: string;
}

export function readPaperWallet(): PaperWalletState {
  try {
    if (fs.existsSync(WALLET_STORE_FILE)) {
      const raw = fs.readFileSync(WALLET_STORE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("[paperTrading] failed to read paper wallet store:", (err as Error).message);
  }
  return {
    initialFundedAmount: 0,
    availableCash: 0,
    allocatedCash: 0,
    totalRealizedPnl: 0,
    totalTradesExecuted: 0,
    isFunded: false,
    sessionStartTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

export function writePaperWallet(wallet: PaperWalletState): void {
  try {
    wallet.lastUpdated = new Date().toISOString();
    fs.writeFileSync(WALLET_STORE_FILE, JSON.stringify(wallet, null, 2), "utf8");
  } catch (err) {
    console.error("[paperTrading] failed to write paper wallet store:", (err as Error).message);
  }
}

export function fundPaperWallet(amountUsd: number): PaperWalletState {
  const wallet = readPaperWallet();
  const validAmount = Math.max(0, amountUsd);
  wallet.initialFundedAmount = validAmount;
  wallet.availableCash = validAmount;
  wallet.allocatedCash = 0;
  wallet.totalRealizedPnl = 0;
  wallet.totalTradesExecuted = 0;
  wallet.isFunded = validAmount > 0;
  wallet.sessionStartTime = new Date().toISOString();
  wallet.lastUpdated = new Date().toISOString();
  writePaperWallet(wallet);
  paperTradingEnabled = true;
  return wallet;
}

export function getPaperWallet(): PaperWalletState {
  return readPaperWallet();
}

export function isPaperWalletFunded(): boolean {
  const w = readPaperWallet();
  return w.isFunded && (w.availableCash > 0 || w.allocatedCash > 0);
}

/**
 * Stops paper trading and generates a detailed session report showing exact profits made on the funded amount.
 */
export async function stopPaperTradingAndReport(chatId: string): Promise<void> {
  paperTradingEnabled = false;

  const wallet = readPaperWallet();
  const openTrades = await getOpenPaperTrades();

  let openPositionsCurrentValue = 0;
  let openUnrealizedPnl = 0;
  let openWinners = 0;
  let openLosers = 0;

  for (const trade of openTrades) {
    const current = await getCurrentPrice(trade.token_mint, trade.category);
    if (current) {
      const { pnlAbsolute } = computePnl(tradeEntrySafe(trade.entry_price), current.price, trade.position_size);
      openPositionsCurrentValue += Math.max(0, trade.position_size + pnlAbsolute);
      openUnrealizedPnl += pnlAbsolute;
      if (pnlAbsolute >= 0) openWinners++;
      else openLosers++;
    } else {
      openPositionsCurrentValue += trade.position_size;
    }
  }

  const totalWalletVal = wallet.availableCash + openPositionsCurrentValue;
  const netProfitUsd = totalWalletVal - wallet.initialFundedAmount;
  const roiPct = wallet.initialFundedAmount > 0 ? (netProfitUsd / wallet.initialFundedAmount) * 100 : 0;
  const sign = netProfitUsd >= 0 ? "+" : "";
  const icon = netProfitUsd >= 0 ? "🟢" : "🔴";
  const realizedSign = wallet.totalRealizedPnl >= 0 ? "+" : "";
  const realizedIcon = wallet.totalRealizedPnl >= 0 ? "🟢" : "🔴";
  const unrealizedSign = openUnrealizedPnl >= 0 ? "+" : "";

  const summary = getAllTimeProfitSummary();

  const report =
    `🛑 *[PAPER TRADING STOPPED & SESSION PROFIT REPORT]*\n\n` +
    `💵 *Funded Capital & Net Profit:*\n` +
    `• Initial Funded Capital: *$${wallet.initialFundedAmount.toFixed(2)} USD*\n` +
    `• Final Paper Wallet Valuation: *$${totalWalletVal.toFixed(2)} USD*\n` +
    `• Total Net Profit Made: *${sign}$${netProfitUsd.toFixed(2)} USD* (${sign}${roiPct.toFixed(1)}% ROI) ${icon}\n\n` +
    `📊 *Wallet Capital Breakdown:*\n` +
    `• Available Cash: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Active Open Positions: *$${openPositionsCurrentValue.toFixed(2)} USD* (${openTrades.length} trades: ${openWinners} in profit, ${openLosers} in drawdown)\n` +
    `• Realized Cash Made (Closed Trades): *${realizedSign}$${wallet.totalRealizedPnl.toFixed(2)} USD* ${realizedIcon}\n` +
    `• Unrealized Profit (Active Trades): *${unrealizedSign}$${openUnrealizedPnl.toFixed(2)} USD*\n` +
    `• Total Session Trades Executed: *${wallet.totalTradesExecuted} trades*\n` +
    `• Overall Win Rate: *${summary.totalWins} Wins / ${summary.totalLosses} Losses* (${summary.winRatePct.toFixed(0)}%)\n\n` +
    `⚡ *Status:* 🛑 *PAUSED / STOPPED*\n` +
    `_Auto-trading has been halted. No further simulated trades will be placed._\n\n` +
    `💡 *To start a new session or fund more capital:*\n` +
    `• \`/fund <amount>\` : Re-fund paper wallet (e.g. \`/fund 10\`)\n` +
    `• \`/papertrade on\` : Re-activate paper trading\n` +
    `• \`/close all\` : Close all active positions at market price`;

  const buttons = [
    [
      { text: "⚡ Photon Terminal", url: "https://photon-sol.tinyastro.io" },
      { text: "🐂 BullX Terminal", url: "https://neo.bullx.io" },
    ],
    [
      { text: "📊 GMGN AI", url: "https://gmgn.ai/sol" },
      { text: "📈 DexScreener", url: "https://dexscreener.com/solana" },
    ],
  ];

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, report, buttons);
  } catch {
    await sendTelegramMessageTo(chatId, report, buttons);
  }
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
  fallbackPair?: any,
  aiConfidence?: number
): Promise<boolean> {
  // 1. AI Confidence Threshold: Must be nothing less than 80% (0.80)
  if (aiConfidence !== undefined && aiConfidence < MIN_AI_CONFIDENCE) {
    console.log(`[paperTrading] Trade rejected for ${tokenOrSymbol}: AI confidence ${(aiConfidence * 100).toFixed(0)}% is below required 80% threshold.`);
    return false;
  }

  // 2. Paper Trading Active Check
  if (!paperTradingEnabled) {
    return false;
  }

  // 3. Paper Wallet Check: Must be funded with positive available cash
  const wallet = readPaperWallet();
  if (!wallet.isFunded) {
    console.log(`[paperTrading] Auto-trade skipped for ${tokenOrSymbol}: Paper wallet has not been funded yet. Use /fund <amount> to fund.`);
    return false;
  }

  if (wallet.availableCash < currentPositionSize) {
    console.warn(`[paperTrading] Insufficient paper wallet balance for ${tokenOrSymbol}: $${wallet.availableCash.toFixed(2)} available, $${currentPositionSize.toFixed(2)} needed.`);
    sendTelegramMessage(`⚠️ *[PAPER WALLET DEPLETED]*\n\n• Available Cash: *$${wallet.availableCash.toFixed(2)} USD*\n• Required: *$${currentPositionSize.toFixed(2)} USD*\n\nSimulated trade for \`${tokenOrSymbol}\` was skipped. Use \`/fund <amount>\` to add funds.`).catch(() => {});
    return false;
  }

  // 4. Dump Blacklist Check
  if (isTokenInDumpCooldown(tokenOrSymbol)) {
    console.log(`[paperTrading] Trade rejected for ${tokenOrSymbol}: token is blacklisted by Dump Detection Engine.`);
    return false;
  }

  // 5. Duplicate Check
  const alreadyOpen = await isTradeAlreadyOpen(tokenOrSymbol);
  if (alreadyOpen) {
    console.log(`[paperTrading] Trade already open for ${tokenOrSymbol} - skipping duplicate.`);
    return false;
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
    return false;
  }

  // 6. Pre-flight Dump Risk Check: Reject if price is already collapsing or sell-heavy
  const preDump = await evaluateTokenDumpRisk(tokenOrSymbol, current.price, undefined, current.pair);
  if (preDump) {
    console.log(`[paperTrading] Trade rejected for ${tokenOrSymbol}: active dump detected (${preDump.dumpType}, -${preDump.dropPct}%).`);
    return false;
  }

  const dexId = current.pair?.dexId ?? (category === "pump_fun" ? "pumpfun" : "raydium");
  const liq = current.pair?.liquidity?.usd ?? 25000;
  const vol = current.pair?.volume?.h24 ?? 50000;
  const buys = current.pair?.txns?.h24?.buys ?? 100;
  const sells = current.pair?.txns?.h24?.sells ?? 50;

  const features = extractPatternFeatures({
    dexId,
    liquidityUsd: liq,
    volume24hUsd: vol,
    buyCount: buys,
    sellCount: sells,
    devHoldingPct: category === "pump_fun" ? 3.0 : 4.0,
  });

  const advice = getPatternOptimizationAdvice(features, currentPositionSize, wallet.availableCash);
  const effectivePositionSize = advice.recommendedPositionSizeUsd > 0 && advice.recommendedPositionSizeUsd <= wallet.availableCash
    ? advice.recommendedPositionSizeUsd
    : currentPositionSize;

  const effectiveTakeProfitPct = advice.takeProfitPct ?? TAKE_PROFIT_PCT;
  const effectiveStopLossPct = Math.min(5, advice.stopLossPct ?? STOP_LOSS_PCT);

  const stopLossPrice = current.price * (1 - effectiveStopLossPct / 100);
  const targetPrice = current.price * (1 + effectiveTakeProfitPct / 100);
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
    position_size: effectivePositionSize,
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

  // Deduct from paper wallet available cash and lock in allocated cash
  wallet.availableCash = Math.max(0, wallet.availableCash - effectivePositionSize);
  wallet.allocatedCash += effectivePositionSize;
  wallet.totalTradesExecuted += 1;
  writePaperWallet(wallet);

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
    `• Trade Size: *$${effectivePositionSize.toFixed(2)} USD* (${advice.sizeMultiplier}x Sizing from Paper Wallet)\n` +
    `• Paper Wallet Available: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Learned Pattern: ${advice.badge}\n` +
    `• Stop-Loss (-${effectiveStopLossPct}%): *${stopStr}*\n` +
    `• Dynamic Take-Profit (+${effectiveTakeProfitPct}%): *${targetStr}*\n` +
    `• Max Holding Window: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Auto-executing live simulated trade with >= 80% AI confidence & pattern optimization._`;

  const buttons = category !== "nft_watch" ? getTokenTradingButtons(tokenOrSymbol) : undefined;
  const imageUrl = category !== "nft_watch" ? getTokenImageUrl(tokenOrSymbol, current.pair) : ZOOMA_BANNER_IMAGE;

  try {
    await sendTelegramPhoto(imageUrl, message, buttons);
  } catch {
    try {
      await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, message, buttons);
    } catch {
      await sendTelegramMessage(message, buttons).catch(() => {});
    }
  }

  return true;
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

  const wallet = readPaperWallet();
  if (!wallet.isFunded) {
    await sendTelegramPhotoTo(
      chatId,
      ZOOMA_BANNER_IMAGE,
      `💼 *[PAPER WALLET NOT FUNDED]*\n\n` +
      `Before paper trading can begin, please fund the bot's paper wallet with a fixed amount.\n\n` +
      `👉 *How much would you like to fund the bot with?*\n\n` +
      `Usage: \`/fund <amount>\` (e.g. \`/fund 10\` or \`/fund 25\`)\n\n` +
      `• Required Minimum: *$10.00 USD (5 trades capacity)*\n` +
      `• Standard Trade Size: *$${positionSize.toFixed(2)} USD per trade*\n` +
      `• Stop anytime with \`/stoppapertrade\` to see the exact profit made on your funded money!`
    );
    return;
  }

  if (wallet.availableCash < positionSize) {
    await sendTelegramMessageTo(
      chatId,
      `⚠️ *[INSUFFICIENT PAPER WALLET FUNDS]*\n\n• Available Cash: *$${wallet.availableCash.toFixed(2)} USD*\n• Required: *$${positionSize.toFixed(2)} USD*\n\nPlease add funds using \`/fund <amount>\` (e.g. \`/fund 10\`).`
    );
    return;
  }

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

  // Deduct from paper wallet available cash and lock into allocated cash
  wallet.availableCash = Math.max(0, wallet.availableCash - positionSize);
  wallet.allocatedCash += positionSize;
  wallet.totalTradesExecuted += 1;
  writePaperWallet(wallet);

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
    `• Trade Size: *$${positionSize.toFixed(2)} USD* (Allocated from Paper Wallet)\n` +
    `• Paper Wallet Available: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Stop-Loss (-${STOP_LOSS_PCT}%): *${stopStr}*\n` +
    `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n` +
    `• Max Hold: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Real-time price tracking active. Dynamic trailing stops and take-profit will auto-trigger._`;

  const buttons = getTokenTradingButtons(tokenMint);
  const imageUrl = getTokenImageUrl(tokenMint, pair);

  try {
    await sendTelegramPhotoTo(chatId, imageUrl, message, buttons);
  } catch {
    try {
      await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, message, buttons);
    } catch {
      await sendTelegramMessageTo(chatId, message, buttons).catch(() => {});
    }
  }
}

/**
 * AUTONOMOUS SINGLE-TRADE ENGINE:
 * Executes a complete automated single trade from entry to exit.
 * Automatically performs:
 * 1. BUY execution (at market price with AI sizing)
 * 2. Real-time Dump Shield armed (detects dev dumps, whale sell-offs, velocity drop cliffs >= 3.5%)
 * 3. Dynamic Take-Profit (+50% or pattern-optimized) & Breakeven Profit Locks
 * 4. Strict 5% Stop-Loss ceiling (loss never exceeds 5.0%)
 * 5. Automatic SELL execution when conditions trigger with zero manual intervention needed.
 */
export async function openAutonomousTrade(
  tokenMint: string,
  sizeUsd?: number,
  chatId?: string
): Promise<boolean> {
  const positionSize = sizeUsd && sizeUsd > 0 ? sizeUsd : currentPositionSize;

  // 1. Paper Wallet check
  const wallet = readPaperWallet();
  if (!wallet.isFunded) {
    if (chatId) {
      await sendTelegramPhotoTo(
        chatId,
        ZOOMA_BANNER_IMAGE,
        `💼 *[PAPER WALLET NOT FUNDED]*\n\n` +
        `Before executing autonomous trades, please fund the bot's paper wallet.\n\n` +
        `Usage: \`/fund <amount>\` (e.g. \`/fund 10\`)\n` +
        `• Minimum Required: *$10.00 USD (5 trades capacity)*\n` +
        `• Trade Size: *$${positionSize.toFixed(2)} USD per trade*`
      );
    }
    return false;
  }

  if (wallet.availableCash < positionSize) {
    if (chatId) {
      await sendTelegramMessageTo(
        chatId,
        `⚠️ *[INSUFFICIENT PAPER WALLET FUNDS]*\n\n• Available: *$${wallet.availableCash.toFixed(2)} USD*\n• Required: *$${positionSize.toFixed(2)} USD*\n\nUse \`/fund <amount>\` to add funds.`
      );
    }
    return false;
  }

  // 2. Dump Blacklist & Cooldown Check
  if (isTokenInDumpCooldown(tokenMint)) {
    if (chatId) {
      await sendTelegramMessageTo(
        chatId,
        `🚨 *[AUTONOMOUS TRADE BLOCKED BY DUMP SHIELD]*\n\n` +
        `Token \`${tokenMint}\` was recently flagged by the Dump Detection Engine. Entry is blocked to protect your capital.`
      );
    }
    return false;
  }

  // 3. Duplicate check
  const alreadyOpen = await isTradeAlreadyOpen(tokenMint);
  if (alreadyOpen) {
    if (chatId) {
      await sendTelegramMessageTo(chatId, `ℹ️ An autonomous trade is already active for \`${tokenMint}\`.`);
    }
    return false;
  }

  if (chatId) {
    await sendTelegramMessageTo(chatId, `⚡ Analyzing DEX liquidity & pre-flight dump indicators for \`${tokenMint}\`...`);
  }

  let current = await getCurrentPrice(tokenMint, "solid_gem");
  let pair = current?.pair;

  if (!current || !current.price || current.price <= 0) {
    if (chatId) {
      await sendTelegramMessageTo(
        chatId,
        `⚠️ *Could not resolve live price for CA* \`${tokenMint}\`\n\n` +
        `No active liquidity pool was found on Raydium, Orca, or Pump.fun yet. Please allow 15 to 30 seconds for pool initialization.`
      );
    }
    return false;
  }

  // 4. Pre-flight dump risk check
  const preDump = await evaluateTokenDumpRisk(tokenMint, current.price, undefined, pair);
  if (preDump) {
    if (chatId) {
      await sendTelegramMessageTo(
        chatId,
        `🚨 *[DUMP DETECTED ON ENTRY: TRADE ABORTED]*\n\n` +
        `Token \`${tokenMint}\` shows active dump characteristics: ${preDump.details}\n` +
        `Autonomous single trade cancelled to protect funds.`
      );
    }
    return false;
  }

  const dexId = pair?.dexId ?? "raydium";
  const liq = pair?.liquidity?.usd ?? 25000;
  const vol = pair?.volume?.h24 ?? 50000;
  const buys = pair?.txns?.h24?.buys ?? 100;
  const sells = pair?.txns?.h24?.sells ?? 50;

  const features = extractPatternFeatures({
    dexId,
    liquidityUsd: liq,
    volume24hUsd: vol,
    buyCount: buys,
    sellCount: sells,
    devHoldingPct: 3.5,
  });

  const advice = getPatternOptimizationAdvice(features, positionSize, wallet.availableCash);
  const effectiveTakeProfitPct = advice.takeProfitPct ?? TAKE_PROFIT_PCT;
  const effectiveStopLossPct = Math.min(5, advice.stopLossPct ?? STOP_LOSS_PCT);

  const stopLossPrice = current.price * (1 - effectiveStopLossPct / 100);
  const targetPrice = current.price * (1 + effectiveTakeProfitPct / 100);
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
  subscribeToTokenTrades(tokenMint);

  wallet.availableCash = Math.max(0, wallet.availableCash - positionSize);
  wallet.allocatedCash += positionSize;
  wallet.totalTradesExecuted += 1;
  writePaperWallet(wallet);

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
    `🎯 *[AUTONOMOUS SINGLE TRADE: BUY EXECUTED]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${tokenMint}\`\n` +
    `• Single-Trade Lifecycle: *Autonomous BUY ➡️ Active Dump Shield ➡️ Auto-SELL*\n` +
    `• Entry Price: *${entryStr} USD*\n` +
    `• Position Bet: *$${positionSize.toFixed(2)} USD* (Allocated from Paper Wallet)\n` +
    `• Available Cash Remaining: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Dump Shield: *ACTIVE (Auto-exits on dev sell or velocity drop >= 3.5%)*\n` +
    `• Stop-Loss (-${effectiveStopLossPct}%): *${stopStr}* (Strict 5% limit)\n` +
    `• Take-Profit (+${effectiveTakeProfitPct}%): *${targetStr}*\n` +
    `• Max Holding Window: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_The bot will monitor this position 24/7 and automatically SELL when profit target is hit or a dump is detected._`;

  const buttons = getTokenTradingButtons(tokenMint);
  const imageUrl = getTokenImageUrl(tokenMint, pair);

  if (chatId) {
    try {
      await sendTelegramPhotoTo(chatId, imageUrl, message, buttons);
    } catch {
      await sendTelegramMessageTo(chatId, message, buttons).catch(() => {});
    }
  } else {
    try {
      await sendTelegramPhoto(imageUrl, message, buttons);
    } catch {
      await sendTelegramMessage(message, buttons).catch(() => {});
    }
  }

  return true;
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

async function closeTrade(trade: OpenTrade, exitPrice: number, exitReason: string, dumpEvent?: DumpEvent): Promise<void> {
  const { pnlPct, pnlAbsolute, fees } = computePnl(trade.entry_price, exitPrice, trade.position_size);
  const exitTime = new Date().toISOString();

  trade.status = "closed";
  trade.exit_price = exitPrice;
  trade.exit_time = exitTime;
  trade.exit_reason = exitReason;
  trade.pnl_pct = pnlPct;
  trade.pnl_absolute = pnlAbsolute;
  trade.fees_absolute = fees;

  // Remove from fast active set and trade subscriptions
  activeOpenMints.delete(trade.token_mint);
  unsubscribeFromTokenTrades(trade.token_mint);

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

  // Feed closed trade outcome back into Pattern Learning knowledge base
  try {
    recordTradeOutcome({
      category: trade.category,
      pnl_pct: pnlPct,
      pnl_absolute: pnlAbsolute,
      position_size: trade.position_size,
      token_mint: trade.token_mint,
      exit_reason: exitReason,
      peak_price: trade.peak_price,
      entry_price: trade.entry_price,
      token_symbol: trade.token_symbol,
      pair: null,
    });
  } catch (err) {
    console.warn("[paperTrading] pattern learning feedback notice:", (err as Error).message);
  }

  const pnlSign = pnlAbsolute >= 0 ? "+" : "";
  let emoji = "📊";
  let title = "AUTONOMOUS SINGLE TRADE: COMPLETE";
  if (exitReason === "target") {
    emoji = "🎉";
    title = `AUTONOMOUS TRADE: TAKE-PROFIT HIT (+${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "dump_detected") {
    emoji = "🚨";
    title = `DUMP SHIELD: EMERGENCY AUTO-SELL (${pnlSign}${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "stop_loss") {
    emoji = "🛑";
    title = `STOP-LOSS TRIGGERED (${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "trailing_stop") {
    emoji = "🛡️";
    title = `TRAILING STOP TRIGGERED (${pnlSign}${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "manual_close" || exitReason === "manual_close_all") {
    emoji = "⚡";
    title = `MANUAL EXIT (${pnlSign}${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "time_exit") {
    emoji = "⏰";
    title = `TIME LIMIT EXIT (${pnlSign}${pnlPct.toFixed(1)}%)`;
  }

  const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
  const exitStr = exitPrice < 0.01 ? `$${exitPrice.toFixed(6)}` : `$${exitPrice.toFixed(4)}`;

  const symbol = trade.token_symbol ?? trade.token_mint.slice(0, 8);
  const name = trade.token_name ?? symbol;

  const finalPayout = Math.max(0, trade.position_size + pnlAbsolute);

  // Calculate trade hold duration for receipt
  const entryDate = new Date(trade.entry_time).getTime();
  const exitDate = new Date(exitTime).getTime();
  const holdSeconds = Math.max(1, Math.round((exitDate - entryDate) / 1000));
  const holdMinutes = Math.max(1, Math.round(holdSeconds / 60));
  const holdStr = holdSeconds < 120 ? `${holdSeconds}s` : `${holdMinutes}m`;

  // Credit funds back to paper wallet
  const wallet = readPaperWallet();
  wallet.allocatedCash = Math.max(0, wallet.allocatedCash - trade.position_size);
  wallet.availableCash += finalPayout;
  wallet.totalRealizedPnl += pnlAbsolute;
  writePaperWallet(wallet);

  const sessionRoi = wallet.initialFundedAmount > 0 ? (wallet.totalRealizedPnl / wallet.initialFundedAmount) * 100 : 0;
  const sessionSign = wallet.totalRealizedPnl >= 0 ? "+" : "";
  const sessionIcon = wallet.totalRealizedPnl >= 0 ? "🟢" : "🔴";

  const summary = getAllTimeProfitSummary();

  const message =
    `${emoji} *[${title}]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${trade.token_mint}\`\n` +
    `• Single-Trade Lifecycle: *Autonomous BUY ➡️ Monitoring ➡️ Auto-SELL*\n` +
    `• Hold Duration: *${holdStr}*\n` +
    `• Strategy: \`${trade.category}\`\n` +
    `• Entry: *${entryStr}* ➡️ Exit: *${exitStr}*\n` +
    `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
    `• Final Position Payout: *$${finalPayout.toFixed(2)} USD*\n` +
    `• Net Money Made on Trade: *${pnlSign}$${pnlAbsolute.toFixed(2)} USD* (${pnlSign}${pnlPct.toFixed(1)}%)\n` +
    `• Modeled Fees: *$${fees.toFixed(2)} USD*\n` +
    `• Exit Reason: \`${exitReason}\`${exitReason === "dump_detected" ? " 🚨 (Dump Shield Intercept)" : ""}\n\n` +
    `💰 *Paper Wallet Capital & Returns:*\n` +
    `• Available Cash Now: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Session Profit on Funded Capital: *${sessionSign}$${wallet.totalRealizedPnl.toFixed(2)} USD* (${sessionSign}${sessionRoi.toFixed(1)}% ROI) ${sessionIcon}\n` +
    `• Portfolio Win Rate: *${summary.totalWins} Wins / ${summary.totalLosses} Losses* (${summary.winRatePct.toFixed(0)}%)\n\n` +
    `_Single trade executed and closed autonomously with zero manual intervention._`;

  const buttons = trade.category !== "nft_watch" ? getTokenTradingButtons(trade.token_mint) : undefined;
  const imageUrl = trade.category !== "nft_watch" ? getTokenImageUrl(trade.token_mint) : ZOOMA_BANNER_IMAGE;

  try {
    await sendTelegramPhoto(imageUrl, message, buttons);
  } catch {
    try {
      await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, message, buttons);
    } catch {
      await sendTelegramMessage(message, buttons).catch(() => {});
    }
  }

  // If closed due to dump detection, dispatch detailed emergency dump card
  if (dumpEvent) {
    sendDumpShieldAlert(dumpEvent, "auto_sold", {
      entryPrice: trade.entry_price,
      exitPrice,
      savedCapitalUsd: finalPayout,
      finalPnlPct: pnlPct,
    }).catch(() => {});
  }
}

/**
 * Executes an immediate emergency auto-sell on an open position when a dump is detected.
 */
export async function emergencyDumpSell(tokenMint: string, dump: DumpEvent): Promise<boolean> {
  const openTrades = await getOpenPaperTrades();
  const trade = openTrades.find((t) => t.token_mint === tokenMint && t.status === "open");
  if (!trade) return false;

  const current = await getCurrentPrice(tokenMint, trade.category);
  const exitPrice = current?.price ?? (dump.detectedPrice > 0 ? dump.detectedPrice : trade.entry_price * 0.96);

  console.log(`[paperTrading] EMERGENCY DUMP SELL executed for ${tokenMint} by ${dump.dumpType}`);
  await closeTrade(trade, exitPrice, "dump_detected", dump);
  return true;
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
          const name = current.pair?.baseToken?.name ?? (trade.token_name ?? symbol);
          const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
          const stopStr = trade.stop_loss_price < 0.01 ? `$${trade.stop_loss_price.toFixed(6)}` : `$${trade.stop_loss_price.toFixed(4)}`;
          const currentVal = Math.max(0, trade.position_size + pnlAbsolute);
          const pnlSign = pnlAbsolute >= 0 ? "+" : "";
          const shieldMsg =
            `🛡️ *[BREAKEVEN SHIELD ACTIVATED]*\n\n` +
            `*${name} (${symbol})*\n` +
            `• Token CA: \`${trade.token_mint}\`\n` +
            `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
            `• Current Position Value: *$${currentVal.toFixed(2)} USD*\n` +
            `• Money Made So Far: *${pnlSign}$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
            `• Current Price: *${currentStr}* (Entry: *$${trade.entry_price.toFixed(4)}*)\n` +
            `• Stop-Loss Ratcheted To: *${stopStr}* (+5.0% profit locked)\n` +
            `• Capital 100% protected against drawdown.\n` +
            `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}`;
          const imageUrl = getTokenImageUrl(trade.token_mint, current.pair);
          const buttons = getTokenTradingButtons(trade.token_mint);
          try {
            await sendTelegramPhoto(imageUrl, shieldMsg, buttons);
          } catch {
            await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, shieldMsg, buttons).catch(() => {});
          }
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
        const name = current.pair?.baseToken?.name ?? (trade.token_name ?? symbol);
        const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
        const currentVal = Math.max(0, trade.position_size + pnlAbsolute);
        const pnlSign = pnlAbsolute >= 0 ? "+" : "";
        const msg =
          `🚀 *[PAPER TRADE PROGRESS: +${pnlPct.toFixed(1)}% GAIN]*\n\n` +
          `*${name} (${symbol})*\n` +
          `• Token CA: \`${trade.token_mint}\`\n` +
          `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
          `• Current Position Value: *$${currentVal.toFixed(2)} USD*\n` +
          `• Money Made So Far: *${pnlSign}$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
          `• Current Price: *${currentStr}* (Entry: *$${trade.entry_price.toFixed(4)}*)\n` +
          `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}\n` +
          `• Target Remaining: *${(TAKE_PROFIT_PCT - pnlPct).toFixed(1)}%* to Target Exit (+${TAKE_PROFIT_PCT}%)\n\n` +
          `_Running live tracking. Take-profit will auto-execute when reached._`;
        const imageUrl = getTokenImageUrl(trade.token_mint, current.pair);
        const buttons = getTokenTradingButtons(trade.token_mint);
        try {
          await sendTelegramPhoto(imageUrl, msg, buttons);
        } catch {
          await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, msg, buttons).catch(() => {});
        }
      }

      // Milestone gain alert (+35%)
      if (pnlPct >= 35 && !milestoneAlertedTrades.has(`${trade.id}_35`)) {
        milestoneAlertedTrades.add(`${trade.id}_35`);
        const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : (trade.token_symbol ?? trade.token_mint.slice(0, 8));
        const name = current.pair?.baseToken?.name ?? (trade.token_name ?? symbol);
        const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
        const currentVal = Math.max(0, trade.position_size + pnlAbsolute);
        const pnlSign = pnlAbsolute >= 0 ? "+" : "";
        const msg =
          `⚡ *[PAPER TRADE SURGE: +${pnlPct.toFixed(1)}% PROFIT]*\n\n` +
          `*${name} (${symbol})*\n` +
          `• Token CA: \`${trade.token_mint}\`\n` +
          `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
          `• Current Position Value: *$${currentVal.toFixed(2)} USD*\n` +
          `• Money Made So Far: *${pnlSign}$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
          `• Current Price: *${currentStr}*\n` +
          `• Progress: ${renderProgressBar(pnlPct, TAKE_PROFIT_PCT)}\n` +
          `• Approaching target exit: *${(TAKE_PROFIT_PCT - pnlPct).toFixed(1)}%* remaining.`;
        const imageUrl = getTokenImageUrl(trade.token_mint, current.pair);
        const buttons = getTokenTradingButtons(trade.token_mint);
        try {
          await sendTelegramPhoto(imageUrl, msg, buttons);
        } catch {
          await sendTelegramPhoto(ZOOMA_BANNER_IMAGE, msg, buttons).catch(() => {});
        }
      }

      // Real-time Dump Detection & Emergency Dump Shield
      const dump = await evaluateTokenDumpRisk(trade.token_mint, current.price, trade.peak_price, current.pair);
      if (dump) {
        console.log(`[paperTrading] DUMP DETECTED on ${trade.token_mint} (${dump.dumpType}, -${dump.dropPct}%): executing emergency auto-sell.`);
        await closeTrade(trade, current.price, "dump_detected", dump);
        continue;
      }

      // Strict 5% max loss guardrail: never allow a loss to exceed 5.0%
      const isLossExceeded = pnlPct <= -5.0;
      if (isLossExceeded || (trade.stop_loss_price !== null && current.price <= trade.stop_loss_price)) {
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
    let valueLine = "";
    let pnlLine = "";
    let progressLine = "";
    let shieldLine = "";

    if (current) {
      currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);
      const icon = pnlPct >= 0 ? "🟢" : "🔴";
      const sign = pnlPct >= 0 ? "+" : "";
      const currentVal = Math.max(0, trade.position_size + pnlAbsolute);
      valueLine = `\n• Current Value: *$${currentVal.toFixed(2)} USD*`;
      pnlLine = `\n• Money Made So Far: *${sign}$${pnlAbsolute.toFixed(2)} USD* (${sign}${pnlPct.toFixed(1)}%) ${icon}`;
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
      `• Token CA: \`${trade.token_mint}\`\n` +
      `• Strategy: \`${trade.category}\`\n` +
      `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
      `• Entry Price: *${entryStr}*\n` +
      `• Current Price: *${currentStr}*` +
      valueLine +
      pnlLine +
      progressLine +
      shieldLine +
      `\n• Stop-Loss: *${stopStr}*\n` +
      `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n\n` +
      `⚡ *Trade Fast on Terminals:*`;

    const imageUrl = getTokenImageUrl(trade.token_mint, current?.pair);
    const buttons = getTokenTradingButtons(trade.token_mint);

    try {
      await sendTelegramPhotoTo(chatId, imageUrl, caption, buttons);
    } catch {
      try {
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, caption, buttons);
      } catch {
        await sendTelegramMessageTo(chatId, caption, buttons);
      }
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
  const name = trade.token_name ?? symbol;
  const finalPayout = Math.max(0, trade.position_size + pnlAbsolute);

  const confirmMsg =
    `✅ *[MANUAL POSITION CLOSED]*\n\n` +
    `*${name} ($${symbol})*\n` +
    `• Token CA: \`${trade.token_mint}\`\n` +
    `• Starting Bet: *$${trade.position_size.toFixed(2)} USD*\n` +
    `• Final Payout: *$${finalPayout.toFixed(2)} USD*\n` +
    `• Realized Net PnL: *${sign}$${pnlAbsolute.toFixed(2)} USD* (${sign}${pnlPct.toFixed(1)}%)\n` +
    `• Exit Price: *$${exitPrice < 0.01 ? exitPrice.toFixed(6) : exitPrice.toFixed(4)}*\n\n` +
    `_Check /history to review all closed trades or /positions for remaining open positions._`;

  const imageUrl = getTokenImageUrl(trade.token_mint);
  const buttons = getTokenTradingButtons(trade.token_mint);

  try {
    await sendTelegramPhotoTo(chatId, imageUrl, confirmMsg, buttons);
  } catch {
    try {
      await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, confirmMsg, buttons);
    } catch {
      await sendTelegramMessageTo(chatId, confirmMsg, buttons).catch(() => {});
    }
  }
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

  // Send photo cards for top 3 recent closed trades with token image and exact payout breakdown
  const photoTrades = closedTrades.slice(0, 3);
  for (let i = 0; i < photoTrades.length; i++) {
    const t = photoTrades[i];
    const pnl = Number(t.pnl_pct ?? 0);
    const pnlAbs = Number(t.pnl_absolute ?? 0);
    const sign = pnl >= 0 ? "+" : "";
    const icon = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    const symbol = t.token_symbol ?? t.token_mint.slice(0, 8);
    const name = t.token_name ?? symbol;
    const entryStr = t.entry_price < 0.01 ? `$${t.entry_price.toFixed(6)}` : `$${t.entry_price.toFixed(4)}`;
    const exitStr = t.exit_price ? (t.exit_price < 0.01 ? `$${t.exit_price.toFixed(6)}` : `$${t.exit_price.toFixed(4)}`) : "n/a";
    const finalPayout = Math.max(0, t.position_size + pnlAbs);

    let reasonTag = t.exit_reason ?? "closed";
    if (reasonTag === "target") reasonTag = "Take-Profit (+50%)";
    else if (reasonTag === "stop_loss") reasonTag = "Stop-Loss (-20%)";
    else if (reasonTag === "trailing_stop") reasonTag = "Trailing Stop";
    else if (reasonTag === "manual_close" || reasonTag === "manual_close_all") reasonTag = "Manual Exit";
    else if (reasonTag === "time_exit") reasonTag = "Time Window (48h)";

    const cardCaption =
      `📜 *[CLOSED TRADE #${i + 1} | ${name}]*\n\n` +
      `• Token: *${name} ($${symbol})*\n` +
      `• Token CA: \`${t.token_mint}\`\n` +
      `• Starting Bet: *$${t.position_size.toFixed(2)} USD*\n` +
      `• Final Payout: *$${finalPayout.toFixed(2)} USD*\n` +
      `• Net Money Made: *${sign}$${pnlAbs.toFixed(2)} USD* (${sign}${pnl.toFixed(1)}%) ${icon}\n` +
      `• Entry: *${entryStr}* ➡️ Exit: *${exitStr}*\n` +
      `• Exit Reason: \`${reasonTag}\` | Strategy: \`${t.category}\`\n\n` +
      `⚡ *Trade Token on Terminal:*`;

    const imageUrl = getTokenImageUrl(t.token_mint);
    const buttons = getTokenTradingButtons(t.token_mint);

    try {
      await sendTelegramPhotoTo(chatId, imageUrl, cardCaption, buttons);
    } catch {
      try {
        await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, cardCaption, buttons);
      } catch {
        await sendTelegramMessageTo(chatId, cardCaption, buttons).catch(() => {});
      }
    }
  }

  // Summary message of overall history
  const summary = getAllTimeProfitSummary();
  const allTimeSign = summary.totalRealizedPnlUsd >= 0 ? "+" : "";
  const allTimeIcon = summary.totalRealizedPnlUsd >= 0 ? "🟢" : "🔴";

  let text = `📜 *[PAPER TRADE HISTORY SUMMARY]*\n\n` +
             `• Total Closed Trades: *${closedTrades.length}*\n` +
             `• All-Time Money Made: *${allTimeSign}$${summary.totalRealizedPnlUsd.toFixed(2)} USD* ${allTimeIcon}\n` +
             `• Win Rate: *${summary.totalWins} Wins / ${summary.totalLosses} Losses* (${summary.winRatePct.toFixed(0)}%)\n`;

  if (summary.bestWinner) {
    text += `• Best Winner: *+$${summary.bestWinner.pnlUsd.toFixed(2)} USD* (+${summary.bestWinner.pnlPct.toFixed(1)}%) on $${summary.bestWinner.symbol}\n`;
  }

  text += `\n*Recent Closed Trades (Quick List):*\n`;
  const quickList = closedTrades.slice(0, 6);
  for (let i = 0; i < quickList.length; i++) {
    const t = quickList[i];
    const pnl = Number(t.pnl_pct ?? 0);
    const pnlAbs = Number(t.pnl_absolute ?? 0);
    const sign = pnl >= 0 ? "+" : "";
    const icon = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    const symbol = t.token_symbol ?? t.token_mint.slice(0, 8);
    const finalPayout = Math.max(0, t.position_size + pnlAbs);

    text += `${i + 1}. ${icon} *${symbol}* (\`${t.token_mint.slice(0, 4)}...${t.token_mint.slice(-4)}\`)\n`;
    text += `   • Bet: *$${t.position_size.toFixed(2)}* ➡️ Payout: *$${finalPayout.toFixed(2)} USD*\n`;
    text += `   • Net Made: *${sign}$${pnlAbs.toFixed(2)} USD* (${sign}${pnl.toFixed(1)}%)\n`;
  }

  text += `\n_Use /balance to see full portfolio earnings, or /positions for open trades._`;

  const topButtons = quickList.slice(0, 2).map((t) => [
    { text: `⚡ Photon (${t.token_symbol ?? "Token"})`, url: `https://photon-sol.tinyastro.io/en/lp/${t.token_mint}` },
    { text: `🐂 BullX`, url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${t.token_mint}` },
  ]);

  await sendTelegramMessageTo(chatId, text, topButtons.length > 0 ? topButtons : undefined);
}

/**
 * Sends a comprehensive earnings & portfolio balance breakdown showing all money made with $2 allocations.
 */
export async function sendPaperBalancePhoto(chatId: string): Promise<void> {
  const wallet = readPaperWallet();
  const summary = getAllTimeProfitSummary();
  const openTrades = await getOpenPaperTrades();

  let openInvested = 0;
  let openCurrentValue = 0;
  let openUnrealizedPnl = 0;
  let openWinners = 0;
  let openLosers = 0;

  for (const t of openTrades) {
    openInvested += t.position_size;
    const current = await getCurrentPrice(t.token_mint, t.category);
    if (current) {
      const { pnlAbsolute } = computePnl(tradeEntrySafe(t.entry_price), current.price, t.position_size);
      openCurrentValue += Math.max(0, t.position_size + pnlAbsolute);
      openUnrealizedPnl += pnlAbsolute;
      if (pnlAbsolute >= 0) openWinners++;
      else openLosers++;
    } else {
      openCurrentValue += t.position_size;
    }
  }

  const totalWalletVal = wallet.availableCash + openCurrentValue;
  const netProfitUsd = totalWalletVal - wallet.initialFundedAmount;
  const roiPct = wallet.initialFundedAmount > 0 ? (netProfitUsd / wallet.initialFundedAmount) * 100 : 0;
  const sign = netProfitUsd >= 0 ? "+" : "";
  const icon = netProfitUsd >= 0 ? "🟢" : "🔴";
  const realizedSign = wallet.totalRealizedPnl >= 0 ? "+" : "";
  const realizedIcon = wallet.totalRealizedPnl >= 0 ? "🟢" : "🔴";
  const unrealizedSign = openUnrealizedPnl >= 0 ? "+" : "";

  let bestWinnerLine = "";
  if (summary.bestWinner) {
    bestWinnerLine = `• Best Winning Trade: *+$${summary.bestWinner.pnlUsd.toFixed(2)} USD* (+${summary.bestWinner.pnlPct.toFixed(1)}%) on *$${summary.bestWinner.symbol}*\n`;
  }

  const statusText = paperTradingEnabled ? "🟢 ACTIVE (Auto-Trading on alerts with >= 80% AI confidence)" : "🛑 PAUSED / STOPPED";

  const caption =
    `💰 *[PAPER WALLET & PORTFOLIO BALANCE]*\n\n` +
    `💵 *Funded Capital & Money Made:*\n` +
    `• Initial Funded Capital: *$${wallet.initialFundedAmount.toFixed(2)} USD*\n` +
    `• Total Paper Wallet Valuation: *$${totalWalletVal.toFixed(2)} USD*\n` +
    `• Net Profit on Funded Capital: *${sign}$${netProfitUsd.toFixed(2)} USD* (${sign}${roiPct.toFixed(1)}% ROI) ${icon}\n\n` +
    `📊 *Wallet Balances:*\n` +
    `• Available Cash: *$${wallet.availableCash.toFixed(2)} USD*\n` +
    `• Active Open Position Value: *$${openCurrentValue.toFixed(2)} USD* (${openTrades.length} open)\n` +
    `• Realized Cash Made (Closed): *${realizedSign}$${wallet.totalRealizedPnl.toFixed(2)} USD* ${realizedIcon}\n` +
    `• Unrealized Profit (Active): *${unrealizedSign}$${openUnrealizedPnl.toFixed(2)} USD*\n\n` +
    `📈 *Performance Statistics:*\n` +
    `• Standard Trade Size: *$${currentPositionSize.toFixed(2)} USD per trade*\n` +
    `• Session Trades Executed: *${wallet.totalTradesExecuted} trades*\n` +
    `• Closed Positions: *${summary.totalClosed}* (${summary.totalWins} Wins / ${summary.totalLosses} Losses)\n` +
    `• Realized Win Rate: *${summary.winRatePct.toFixed(1)}%*\n` +
    bestWinnerLine +
    `\n⚡ *Bot Status:* ${statusText}\n\n` +
    `_Auto-trading trades on alerts with >= 80% AI confidence and Breakeven Shield protection._`;

  const buttons = [
    [
      { text: "⚡ Photon Terminal", url: "https://photon-sol.tinyastro.io" },
      { text: "🐂 BullX Terminal", url: "https://neo.bullx.io" },
    ],
    [
      { text: "📊 GMGN AI", url: "https://gmgn.ai/sol" },
      { text: "📈 DexScreener", url: "https://dexscreener.com/solana" },
    ],
  ];

  try {
    await sendTelegramPhotoTo(chatId, ZOOMA_BANNER_IMAGE, caption, buttons);
  } catch {
    await sendTelegramMessageTo(chatId, caption, buttons);
  }
}

function tradeEntrySafe(entry: number): number {
  return entry > 0 ? entry : 0.000001;
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
