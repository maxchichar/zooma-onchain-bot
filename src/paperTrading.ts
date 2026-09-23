/**
 * PAPER TRADING — this is the module that actually answers "would this
 * make money," which nothing else in this bot does yet. Every signal
 * (wallet ACCUMULATION, meme coin watch, NFT watch) opens a simulated
 * position automatically. No real funds move. Ever.
 *
 * DESIGN CHOICES:
 *
 * - Entry price is the market price at the moment the trade opens, same
 *   source the research/signal modules already use (DexScreener for SPL
 *   tokens, Magic Eden floor price for NFTs) — no new price feed
 *   dependency introduced.
 *
 * - Fees and slippage are MODELED, not ignored (PAPER_FEE_PCT,
 *   PAPER_SLIPPAGE_PCT, applied on both entry and exit). A backtest that
 *   ignores these overstates performance — this is the #1 way naive
 *   paper trading lies to you.
 *
 * - Exits are rule-based and bounded: stop-loss, take-profit, or a hard
 *   time limit (PAPER_MAX_HOLD_HOURS). The time limit exists because
 *   meme coins in particular can sit indefinitely without hitting either
 *   threshold — without a bound, "open positions" would just accumulate
 *   forever and never produce a closed-trade answer.
 *
 * - pnl_pct (not absolute PnL) is the primary number for aggregate
 *   stats, because trades mix two different quote currencies (USD for
 *   tokens via DexScreener, SOL for NFTs via Magic Eden — no invented
 *   SOL/USD conversion here). Percentage return is comparable across
 *   both; absolute PnL is reported separately, grouped by currency.
 *
 * - computeStats() can and will say "NO EDGE DETECTED" when expectancy
 *   is non-positive. That's a correct output, not a bug to fix.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessage } from "./telegram.js";
import { fetchTokenPairs, fetchCollectionStats } from "./researchSources.js";

const POSITION_SIZE = Number(process.env.PAPER_POSITION_SIZE ?? 100); // in the trade's own quote currency
const STOP_LOSS_PCT = Number(process.env.PAPER_STOP_LOSS_PCT ?? 20); // % below entry
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TAKE_PROFIT_PCT ?? 50); // % above entry
const MAX_HOLD_HOURS = Number(process.env.PAPER_MAX_HOLD_HOURS ?? 48);
const FEE_PCT = Number(process.env.PAPER_FEE_PCT ?? 1); // per side (entry AND exit each pay this)
const SLIPPAGE_PCT = Number(process.env.PAPER_SLIPPAGE_PCT ?? 2); // per side

export type Category = "wallet_pattern" | "meme_coin_watch" | "nft_watch" | "trending_trade";

interface CurrentPrice {
  price: number;
  quoteCurrency: "usd" | "sol";
}

/** Best-effort current price. Returns null if unavailable (thin liquidity, delisted, RPC hiccup, etc). */
async function getCurrentPrice(tokenOrSymbol: string, category: Category): Promise<CurrentPrice | null> {
  if (category === "nft_watch") {
    const stats = await fetchCollectionStats(tokenOrSymbol, "24h");
    if (!stats?.floorPrice) return null;
    return { price: stats.floorPrice / 1_000_000_000, quoteCurrency: "sol" }; // lamports -> SOL
  }

  const pairs = await fetchTokenPairs(tokenOrSymbol);
  if (pairs.length === 0) return null;
  const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);
  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
  if (!priceUsd) return null;
  return { price: priceUsd, quoteCurrency: "usd" };
}

/**
 * Opens a simulated trade for a signal or trending token. Best-effort and non-blocking.
 */
export async function openPaperTrade(signalId: string | null, tokenOrSymbol: string, category: Category): Promise<void> {
  const current = await getCurrentPrice(tokenOrSymbol, category);
  if (!current) {
    console.warn(`[paperTrading] no price available for ${tokenOrSymbol} (${category}) — skipping paper trade.`);
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
    position_size: POSITION_SIZE,
    stop_loss_price: stopLossPrice,
    target_price: targetPrice,
    max_hold_until: maxHoldUntil,
  });

  if (error) {
    console.error("[paperTrading] failed to open paper trade:", error.message);
    return;
  }

  const tag = category === "trending_trade" ? "TRENDING TRADE" : "PAPER TRADE";
  await sendTelegramMessage(
    `*[${tag} OPENED]*\n` +
      `${category === "nft_watch" ? "Collection" : "Token"}: \`${tokenOrSymbol}\`\n` +
      `Category: \`${category}\`\n` +
      `Entry: $${current.price < 0.01 ? current.price.toFixed(6) : current.price.toFixed(4)} ${current.quoteCurrency.toUpperCase()}\n` +
      `Stop: ${stopLossPrice.toFixed(6)} | Target: ${targetPrice.toFixed(6)} | Max hold: ${MAX_HOLD_HOURS}h\n\n` +
      `_Simulated only — tracking live performance net of fees & slippage._`
  );
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
      .gte("entry_time", cutoff)
      .limit(1);

    if ((data?.length ?? 0) > 0) return false;

    await openPaperTrade(null, tokenMint, "trending_trade");
    return true;
  } catch (err) {
    console.warn(`[paperTrading] openTrendingPaperTrade failed for ${tokenMint}:`, (err as Error).message);
    return false;
  }
}

interface OpenTrade {
  id: string;
  token_mint: string;
  category: Category;
  quote_currency: "usd" | "sol";
  entry_price: number;
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

  const resultWord = pnlAbsolute >= 0 ? "WIN" : "LOSS";
  await sendTelegramMessage(
    `*[PAPER TRADE CLOSED — ${resultWord}]*\n` +
      `${trade.category === "nft_watch" ? "Collection" : "Token"}: \`${trade.token_mint}\`\n` +
      `Exit reason: ${exitReason}\n` +
      `PnL: ${pnlPct.toFixed(1)}% (${pnlAbsolute.toFixed(2)} ${trade.quote_currency.toUpperCase()}, fees ${fees.toFixed(2)} included)\n\n` +
      `_Simulated only — no real funds involved._`
  );
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
        // Can't price it — if we're also past the time limit, close it
        // out as unpriceable rather than let it hang forever; otherwise
        // just try again next cycle.
        if (pastMaxHold) {
          console.warn(`[paperTrading] ${trade.token_mint} unpriceable at max-hold — closing with no PnL data.`);
          await supabase
            .from("paper_trades")
            .update({ status: "closed", exit_reason: "price_unavailable", exit_time: new Date().toISOString() })
            .eq("id", trade.id);
        }
        continue;
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

export interface PaperTradingStats {
  windowDays: number;
  closedTrades: number;
  winRate: number | null;
  avgPnlPct: number | null;
  totalPnlByCurrency: Record<string, number>;
  profitFactor: number | null;
  expectancyPct: number | null;
  maxDrawdownPct: number | null;
  verdict: "NO EDGE DETECTED" | "POSITIVE EXPECTANCY — STILL SMALL SAMPLE" | "INSUFFICIENT DATA";
}

/**
 * "If I had followed every signal generated in the last N days, what
 * would have happened?" — the exact question your original brief asked
 * this system to be able to answer.
 */
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

  // Max drawdown over the sequence of trades ordered by entry time, on
  // cumulative pnl_pct (a simplified equity curve — treats each trade as
  // an equal-sized bet adding linearly, not compounding geometrically).
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
    expectancyPct > 0 ? "POSITIVE EXPECTANCY — STILL SMALL SAMPLE" : "NO EDGE DETECTED";

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

function formatStats(label: string, stats: PaperTradingStats): string {
  if (stats.closedTrades === 0) {
    return `${label}: no closed trades yet — nothing to report.`;
  }
  const currencyLines = Object.entries(stats.totalPnlByCurrency)
    .map(([cur, total]) => `${total.toFixed(2)} ${cur.toUpperCase()}`)
    .join(", ");
  return (
    `${label}: ${stats.closedTrades} closed trades\n` +
    `Win rate: ${((stats.winRate ?? 0) * 100).toFixed(0)}% | Avg PnL: ${stats.avgPnlPct?.toFixed(1)}% | ` +
    `Profit factor: ${stats.profitFactor === Infinity ? "∞ (no losses)" : stats.profitFactor?.toFixed(2)}\n` +
    `Total PnL: ${currencyLines || "n/a"} | Max drawdown: ${stats.maxDrawdownPct?.toFixed(1)}%\n` +
    `Verdict: *${stats.verdict}*`
  );
}

/** Sends a periodic performance digest to Telegram. Call on a schedule (e.g. daily). */
export async function sendPerformanceDigest(): Promise<void> {
  const [d7, d30, d90] = await Promise.all([computeStats(7), computeStats(30), computeStats(90)]);

  const message =
    `*[PAPER TRADING DIGEST]*\n` +
    `Answers: "if I'd followed every signal, what would have happened?"\n\n` +
    `${formatStats("Last 7 days", d7)}\n\n${formatStats("Last 30 days", d30)}\n\n${formatStats("Last 90 days", d90)}\n\n` +
    `_All simulated. A verdict is only meaningful once closed-trade counts are reasonably large (rule of thumb: 20+) — small-sample results can flip._`;

  await sendTelegramMessage(message);
}
