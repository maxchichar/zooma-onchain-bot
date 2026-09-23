/**
 * PAPER TRADING ENGINE:
 * Simulates real-time trading for every fired signal (100x gems, solid gems, whale buys, trending, manual).
 * Tracks positions against live DEX market prices with stop-loss (-20%), take-profit (+50%), and max hold (48h).
 * Sends instant Telegram alerts when trades open, hit profit targets, or get stopped out.
 */
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

export type Category =
  | "wallet_pattern"
  | "meme_coin_watch"
  | "nft_watch"
  | "trending_trade"
  | "solid_gem"
  | "whale_entry"
  | "manual_entry";

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
  if (pairs.length === 0) return null;
  const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
  if (!priceUsd) return null;
  return { price: priceUsd, quoteCurrency: "usd", pair };
}

/**
 * Opens a simulated trade for a signal or trending token.
 */
export async function openPaperTrade(
  signalId: string | null,
  tokenOrSymbol: string,
  category: Category,
  fallbackPriceUsd?: number,
  fallbackPair?: any
): Promise<void> {
  if (!paperTradingEnabled) {
    return;
  }

  let current = await getCurrentPrice(tokenOrSymbol, category);
  if (!current && fallbackPriceUsd && fallbackPriceUsd > 0) {
    current = {
      price: fallbackPriceUsd,
      quoteCurrency: "usd",
      pair: fallbackPair,
    };
  }

  if (!current) {
    console.warn(`[paperTrading] no price available for ${tokenOrSymbol} (${category}) - skipping paper trade.`);
    return;
  }

  const stopLossPrice = current.price * (1 - STOP_LOSS_PCT / 100);
  const targetPrice = current.price * (1 + TAKE_PROFIT_PCT / 100);
  const maxHoldUntil = new Date(Date.now() + MAX_HOLD_HOURS * 3600 * 1000).toISOString();

  const { error } = await supabase.from("paper_trades").insert({
    signal_id: signalId ?? null,
    token_mint: tokenOrSymbol,
    category,
    quote_currency: current.quoteCurrency,
    entry_price: current.price,
    position_size: currentPositionSize,
    stop_loss_price: stopLossPrice,
    target_price: targetPrice,
    max_hold_until: maxHoldUntil,
  });

  if (error) {
    console.error("[paperTrading] failed to open paper trade:", error.message);
    return;
  }

  let tag = "SIMULATED PAPER TRADE";
  if (category === "trending_trade") tag = "TRENDING TRADE";
  else if (category === "solid_gem") tag = "SOLID GEM TRADE";
  else if (category === "whale_entry") tag = "WHALE ENTRY TRADE";
  else if (category === "manual_entry") tag = "MANUAL ENTRY TRADE";

  const entryStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
  const stopStr = stopLossPrice < 0.01 ? `$${stopLossPrice.toFixed(6)}` : `$${stopLossPrice.toFixed(4)}`;
  const targetStr = targetPrice < 0.01 ? `$${targetPrice.toFixed(6)}` : `$${targetPrice.toFixed(4)}`;

  const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : tokenOrSymbol.slice(0, 8);

  const message =
    `🎯 *[${tag} OPENED]*\n\n` +
    `• Token: *${symbol}*\n` +
    `• CA: \`${tokenOrSymbol}\`\n` +
    `• Strategy: \`${category}\`\n` +
    `• Entry Price: *${entryStr} ${current.quoteCurrency.toUpperCase()}*\n` +
    `• Position Size: *$${currentPositionSize.toFixed(2)} ${current.quoteCurrency.toUpperCase()}* (Simulated)\n` +
    `• Stop-Loss (-${STOP_LOSS_PCT}%): *${stopStr}*\n` +
    `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n` +
    `• Max Hold: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Live tracking active against real DEX prices (fees & slippage modeled)._`;

  const buttons = category !== "nft_watch" ? getTokenTradingButtons(tokenOrSymbol) : undefined;
  const imageUrl = category !== "nft_watch" ? getTokenImageUrl(tokenOrSymbol, current.pair) : undefined;

  if (imageUrl) {
    await sendTelegramPhoto(imageUrl, message, buttons);
  } else {
    await sendTelegramMessage(message, buttons);
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

  // Check pump.fun drops cache if DexScreener is not indexed yet
  if (!current) {
    const recent = getRecentPumpDrops(50).find((d) => d.mint === tokenMint);
    if (recent) {
      const solPriceEst = 150;
      const estimatedPrice = (recent.marketCapSol * solPriceEst) / 1_000_000_000;
      current = {
        price: estimatedPrice,
        quoteCurrency: "usd",
        pair: {
          baseToken: { address: recent.mint, name: recent.name, symbol: recent.symbol },
          priceUsd: estimatedPrice.toString(),
          liquidity: { usd: recent.marketCapSol * solPriceEst },
          dexId: recent.isRaydiumGraduation ? "raydium" : "pumpfun",
        },
      };
      pair = current.pair;
    }
  }

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
  const maxHoldUntil = new Date(Date.now() + MAX_HOLD_HOURS * 3600 * 1000).toISOString();

  const { error } = await supabase.from("paper_trades").insert({
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

  if (error) {
    console.error("[paperTrading] failed to save manual paper trade:", error.message);
    await sendTelegramMessageTo(chatId, `❌ Failed to open simulated trade: ${error.message}`);
    return;
  }

  const entryStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
  const stopStr = stopLossPrice < 0.01 ? `$${stopLossPrice.toFixed(6)}` : `$${stopLossPrice.toFixed(4)}`;
  const targetStr = targetPrice < 0.01 ? `$${targetPrice.toFixed(6)}` : `$${targetPrice.toFixed(4)}`;
  const symbol = pair?.baseToken?.symbol ? `$${pair.baseToken.symbol}` : tokenMint.slice(0, 8);
  const name = pair?.baseToken?.name ?? symbol;

  const message =
    `🎯 *[MANUAL PAPER TRADE OPENED]*\n\n` +
    `• Token: *${name} (${symbol})*\n` +
    `• CA: \`${tokenMint}\`\n` +
    `• Strategy: \`manual_entry\`\n` +
    `• Entry Price: *${entryStr} USD*\n` +
    `• Position Sizing: *$${positionSize.toFixed(2)} USD* (Simulated)\n` +
    `• Stop-Loss (-${STOP_LOSS_PCT}%): *${stopStr}*\n` +
    `• Take-Profit (+${TAKE_PROFIT_PCT}%): *${targetStr}*\n` +
    `• Max Hold: *${MAX_HOLD_HOURS} hours*\n\n` +
    `_Real-time price tracking active. You will receive an automated alert when target (+50%) or stop-loss (-20%) is hit._`;

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
export async function openTrendingPaperTrade(tokenMint: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from("paper_trades")
      .select("id")
      .eq("token_mint", tokenMint)
      .eq("category", "trending_trade")
      .gte("created_at", cutoff)
      .limit(1);

    if (data && data.length > 0) {
      return false;
    }

    await openPaperTrade(null, tokenMint, "trending_trade");
    return true;
  } catch (err) {
    console.warn(`[paperTrading] openTrendingPaperTrade error for ${tokenMint}:`, (err as Error).message);
    return false;
  }
}

export interface OpenTrade {
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
}

function computePnl(entryPrice: number, exitPrice: number, positionSize: number): { pnlPct: number; pnlAbsolute: number; fees: number } {
  // Slippage: buying costs more than mid, selling nets less than mid.
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

  const { error } = await supabase
    .from("paper_trades")
    .update({
      status: "closed",
      exit_price: exitPrice,
      exit_time: new Date().toISOString(),
      exit_reason: exitReason,
      pnl_pct: pnlPct,
      pnl_absolute: pnlAbsolute,
      fees_absolute: fees,
    })
    .eq("id", trade.id);

  if (error) {
    console.error("[paperTrading] failed to close trade:", error.message);
    return;
  }

  let emoji = "📊";
  let title = "PAPER TRADE CLOSED";
  if (exitReason === "target") {
    emoji = "🎉";
    title = `TAKE-PROFIT HIT (+${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "stop_loss") {
    emoji = "🛑";
    title = `STOP-LOSS TRIGGERED (${pnlPct.toFixed(1)}%)`;
  } else if (exitReason === "time_exit") {
    emoji = "⏰";
    title = `TIME LIMIT EXIT (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`;
  }

  const pnlSign = pnlAbsolute >= 0 ? "+" : "";
  const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
  const exitStr = exitPrice < 0.01 ? `$${exitPrice.toFixed(6)}` : `$${exitPrice.toFixed(4)}`;

  const message =
    `${emoji} *[PAPER TRADE: ${title}]*\n\n` +
    `• Target CA: \`${trade.token_mint}\`\n` +
    `• Strategy: \`${trade.category}\`\n` +
    `• Entry: *${entryStr}* ➡️ Exit: *${exitStr}*\n` +
    `• Realized Net PnL: *${pnlSign}${pnlPct.toFixed(1)}%* (*${pnlSign}$${pnlAbsolute.toFixed(2)} ${trade.quote_currency.toUpperCase()}*)\n` +
    `• Modeled Fees: *$${fees.toFixed(2)}*\n` +
    `• Exit Trigger: \`${exitReason}\`\n\n` +
    `_Simulated performance tracking net of modeled fees & slippage._`;

  const buttons = trade.category !== "nft_watch" ? getTokenTradingButtons(trade.token_mint) : undefined;
  await sendTelegramMessage(message, buttons);
}

/** Checks every open trade against its stop/target/time-limit. Call on a schedule. */
export async function checkOpenTrades(): Promise<void> {
  const { data: openTrades, error } = await supabase.from("paper_trades").select("*").eq("status", "open");
  if (error) {
    console.error("[paperTrading] failed to load open trades:", error.message);
    return;
  }

  for (const trade of (openTrades ?? []) as OpenTrade[]) {
    try {
      const current = await getCurrentPrice(trade.token_mint, trade.category);
      const pastMaxHold = new Date(trade.max_hold_until).getTime() <= Date.now();

      if (!current) {
        if (pastMaxHold) {
          console.warn(`[paperTrading] ${trade.token_mint} unpriceable at max-hold - closing with no PnL data.`);
          await supabase
            .from("paper_trades")
            .update({ status: "closed", exit_reason: "price_unavailable", exit_time: new Date().toISOString() })
            .eq("id", trade.id);
        }
        continue;
      }

      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);

      // Milestone gain alert (+25%)
      if (pnlPct >= 25 && !milestoneAlertedTrades.has(`${trade.id}_25`)) {
        milestoneAlertedTrades.add(`${trade.id}_25`);
        const symbol = current.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : trade.token_mint.slice(0, 8);
        const currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
        const msg =
          `🚀 *[PAPER TRADE PROGRESS: +${pnlPct.toFixed(1)}% GAIN]*\n\n` +
          `• Token: *${symbol}*\n` +
          `• CA: \`${trade.token_mint}\`\n` +
          `• Current Price: *${currentStr}* (Entry: *$${trade.entry_price.toFixed(4)}*)\n` +
          `• Unrealized Profit: *+$${pnlAbsolute.toFixed(2)} USD* (+${pnlPct.toFixed(1)}%)\n` +
          `• Target Remaining: *${(TAKE_PROFIT_PCT - pnlPct).toFixed(1)}%* to Target Exit (+${TAKE_PROFIT_PCT}%)\n\n` +
          `_Running live tracking. Take-profit will auto-execute when reached._`;
        sendTelegramMessage(msg, getTokenTradingButtons(trade.token_mint)).catch(() => {});
      }

      if (trade.stop_loss_price !== null && current.price <= trade.stop_loss_price) {
        await closeTrade(trade, current.price, "stop_loss");
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
  const { data: openTrades, error } = await supabase
    .from("paper_trades")
    .select("*")
    .eq("status", "open")
    .order("entry_time", { ascending: false });

  if (error || !openTrades || openTrades.length === 0) {
    return "ℹ️ No open simulated paper trade positions right now. Trades open automatically when gem alerts, whale buys, or signals fire.";
  }

  let text = `📈 *Active Simulated Paper Positions (${openTrades.length} Open)*\n\n`;
  for (let i = 0; i < openTrades.length; i++) {
    const trade = openTrades[i] as OpenTrade;
    const current = await getCurrentPrice(trade.token_mint, trade.category);

    const entryStr = trade.entry_price < 0.01 ? `$${trade.entry_price.toFixed(6)}` : `$${trade.entry_price.toFixed(4)}`;
    let currentStr = "Pending...";
    let pnlLine = "";

    if (current) {
      currentStr = current.price < 0.01 ? `$${current.price.toFixed(6)}` : `$${current.price.toFixed(4)}`;
      const { pnlPct, pnlAbsolute } = computePnl(trade.entry_price, current.price, trade.position_size);
      const icon = pnlPct >= 0 ? "🟢" : "🔴";
      const sign = pnlPct >= 0 ? "+" : "";
      pnlLine = `\n   • Unrealized PnL: *${sign}${pnlPct.toFixed(1)}%* (${sign}$${pnlAbsolute.toFixed(2)} USD) ${icon}`;
    }

    const symbol = current?.pair?.baseToken?.symbol ? `$${current.pair.baseToken.symbol}` : `Token ${i + 1}`;
    text += `${i + 1}. *${symbol}* (\`${trade.category}\`)\n`;
    text += `   • CA: \`${trade.token_mint}\`\n`;
    text += `   • Entry: ${entryStr} ➡️ Current: ${currentStr}${pnlLine}\n\n`;
  }

  text += `_Exits automatically at Target (+${TAKE_PROFIT_PCT}%), Stop-Loss (-${STOP_LOSS_PCT}%), or ${MAX_HOLD_HOURS}h._`;
  return text;
}

/**
 * Periodically sends an automated portfolio status update to subscribers if there are open positions.
 */
export async function sendPeriodicPortfolioDigest(): Promise<void> {
  const { data: openTrades, error } = await supabase
    .from("paper_trades")
    .select("id")
    .eq("status", "open")
    .limit(1);

  if (error || !openTrades || openTrades.length === 0) {
    return; // Don't send empty spam if no positions are active
  }

  const report = await getOpenPositionsReport();
  const summaryMessage =
    `💼 *[AUTOMATED 30M PORTFOLIO UPDATE]*\n\n` +
    report +
    `\n\n_Auto-monitored 24/7. Target (+${TAKE_PROFIT_PCT}%) and stop-loss (-${STOP_LOSS_PCT}%) will trigger instant exit alerts._`;

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
  let query = supabase.from("paper_trades").select("*").eq("status", "closed").gte("entry_time", since);
  if (category) query = query.eq("category", category);
  const { data, error } = await query;

  if (error || !data || data.length === 0) {
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

  const trades = data as any[];
  const pnlPcts = trades.map((t) => Number(t.pnl_pct));
  const wins = trades.filter((t) => Number(t.pnl_pct) > 0);
  const losses = trades.filter((t) => Number(t.pnl_pct) <= 0);

  const winRate = wins.length / trades.length;
  const avgPnlPct = pnlPcts.reduce((s, p) => s + p, 0) / pnlPcts.length;

  const grossWin = wins.reduce((s, t) => s + Number(t.pnl_pct), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl_pct), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0;

  const expectancyPct = avgPnlPct;

  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime()
  );
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of sorted) {
    cumulative += Number(t.pnl_pct);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }

  const totalPnlByCurrency: Record<string, number> = {};
  for (const t of trades) {
    const cur = t.quote_currency;
    totalPnlByCurrency[cur] = (totalPnlByCurrency[cur] ?? 0) + Number(t.pnl_absolute);
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
