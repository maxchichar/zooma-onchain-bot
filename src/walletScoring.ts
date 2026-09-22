/**
 * WALLET CREDIBILITY SCORING — the piece the original brief asked for
 * that never got built until now: a transparent score per tracked
 * wallet, with visible evidence for why it got that score. No ML, no
 * JEV, no LLM in the scoring math itself — every point is traceable to
 * a specific number, on purpose, matching the "never a black box"
 * requirement from day one of this project.
 *
 * WHERE THE DATA COMES FROM:
 * A wallet contributes to a signal via signal_evidence (source =
 * 'onchain_tx', so this only covers wallet_pattern ACCUMULATION signals
 * — meme coin / NFT research signals aren't tied to a specific wallet's
 * behavior, so they're out of scope for this score by construction).
 * Each such signal has at most one paper trade (paper_trades.signal_id).
 * Once that trade closes, its outcome (pnl_pct) is real evidence about
 * whether being part of that wallet's accumulation pattern was worth
 * anything — not proof about that ONE wallet specifically (multiple
 * wallets share credit for one signal), but it's the best signal this
 * system has, and it's exactly the same evidence a human reviewing this
 * manually would look at.
 *
 * THE SCORE FORMULA (every term below maps directly to an evidence or
 * warning line — nothing hidden):
 *
 *   performanceScore   = winRate * 50 + pnlComponent(avgPnlPct, scale=35)
 *                         (0 if no closed trades yet — an untested wallet
 *                         earns nothing from performance, which is correct)
 *   confidenceMultiplier = min(1, tradesWithOutcome / MIN_TRADES_FOR_FULL_CONFIDENCE)
 *                         (discounts performanceScore when the sample is
 *                         small — a wallet with 1 lucky trade should not
 *                         score like one with 20 consistent ones)
 *   tenureScore        = min(tenureDays / 90, 1) * 15
 *                         (small, capped bonus for a longer track record;
 *                         time tracked isn't performance, so it's kept
 *                         to 15 of 100 points max)
 *   coordinatedPenalty = min(coordinatedFlagCount * 10, 30)
 *                         (JEV flagged this wallet's signals as
 *                         coordinated/wash-like — a real, visible penalty,
 *                         but capped so one flagged instance doesn't wipe
 *                         out an otherwise-good score)
 *
 *   finalScore = clamp(performanceScore * confidenceMultiplier + tenureScore
 *                       - coordinatedPenalty, 0, 100)
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessage } from "./telegram.js";

const MIN_TRADES_FOR_FULL_CONFIDENCE = Number(process.env.WALLET_SCORE_MIN_TRADES ?? 10);

export interface WalletScoreResult {
  wallet: string;
  score: number;
  signalCount: number;
  tradesWithOutcome: number;
  winRate: number | null;
  avgPnlPct: number | null;
  coordinatedFlagCount: number;
  tenureDays: number | null;
  source: string | null;
  evidence: string[];
  warnings: string[];
}

function pnlComponent(avgPnlPct: number): number {
  const clamped = Math.max(-50, Math.min(50, avgPnlPct));
  return ((clamped + 50) / 100) * 35; // -50% -> 0, 0% -> 17.5, +50% -> 35
}

async function scoreOneWallet(wallet: string): Promise<WalletScoreResult | null> {
  // Signals this wallet contributed to (onchain_tx evidence only — see
  // file header for why research signals are out of scope here).
  const { data: evidenceRows, error: evError } = await supabase
    .from("signal_evidence")
    .select("signal_id")
    .eq("wallet", wallet)
    .eq("source", "onchain_tx");
  if (evError || !evidenceRows || evidenceRows.length === 0) return null;

  const signalIds = [...new Set(evidenceRows.map((r) => r.signal_id))];

  const { data: signals } = await supabase.from("signals").select("id, details").in("id", signalIds);
  const coordinatedFlagCount = (signals ?? []).filter((s) => {
    const jevRead = (s.details as any)?.jev_read;
    return jevRead?.pattern === "coordinated_or_wash";
  }).length;

  const { data: trades } = await supabase
    .from("paper_trades")
    .select("pnl_pct, status")
    .in("signal_id", signalIds)
    .eq("status", "closed");

  const closedTrades = trades ?? [];
  const tradesWithOutcome = closedTrades.length;
  const wins = closedTrades.filter((t) => Number(t.pnl_pct) > 0).length;
  const winRate = tradesWithOutcome > 0 ? wins / tradesWithOutcome : null;
  const avgPnlPct =
    tradesWithOutcome > 0 ? closedTrades.reduce((s, t) => s + Number(t.pnl_pct), 0) / tradesWithOutcome : null;

  const { data: walletRow } = await supabase
    .from("tracked_wallets")
    .select("added_at, source")
    .eq("address", wallet)
    .maybeSingle();
  const tenureDays = walletRow ? (Date.now() - new Date(walletRow.added_at).getTime()) / 86_400_000 : null;

  const confidenceMultiplier = Math.min(1, tradesWithOutcome / MIN_TRADES_FOR_FULL_CONFIDENCE);
  const performanceScore = winRate !== null && avgPnlPct !== null ? winRate * 50 + pnlComponent(avgPnlPct) : 0;
  const tenureScore = tenureDays !== null ? Math.min(tenureDays / 90, 1) * 15 : 0;
  const coordinatedPenalty = Math.min(coordinatedFlagCount * 10, 30);
  const score = Math.max(0, Math.min(100, performanceScore * confidenceMultiplier + tenureScore - coordinatedPenalty));

  const evidence: string[] = [];
  const warnings: string[] = [];

  if (tradesWithOutcome > 0) {
    evidence.push(
      `Involved in ${signalIds.length} signal(s), ${wins}/${tradesWithOutcome} profitable in paper trading (${(winRate! * 100).toFixed(0)}% win rate)`
    );
    if (avgPnlPct! > 0) evidence.push(`Average paper-trade return +${avgPnlPct!.toFixed(1)}%`);
    else warnings.push(`Average paper-trade return ${avgPnlPct!.toFixed(1)}% (negative)`);
  } else {
    warnings.push("No closed paper trades yet — score is based on tenure only, not performance");
  }

  if (tradesWithOutcome < MIN_TRADES_FOR_FULL_CONFIDENCE) {
    warnings.push(`Small sample size (${tradesWithOutcome} closed trade(s)) — confidence discounted accordingly`);
  }
  if (tenureDays !== null) {
    if (tenureDays >= 90) evidence.push(`Tracked for ${Math.floor(tenureDays)} days`);
    else warnings.push(`Only ${Math.floor(tenureDays)} days of tracking history`);
  }
  if (coordinatedFlagCount > 0) {
    warnings.push(`Flagged coordinated/wash-like by JEV in ${coordinatedFlagCount} of ${signalIds.length} signal(s)`);
  }
  if (walletRow?.source === "auto_discovered") {
    warnings.push("Auto-discovered wallet — not manually vetted");
  }

  return {
    wallet,
    score,
    signalCount: signalIds.length,
    tradesWithOutcome,
    winRate,
    avgPnlPct,
    coordinatedFlagCount,
    tenureDays,
    source: walletRow?.source ?? null,
    evidence,
    warnings,
  };
}

/** Recomputes and stores a score for every wallet that has contributed to at least one signal. Call on a schedule. */
export async function computeAllWalletScores(): Promise<WalletScoreResult[]> {
  const { data: distinctWallets } = await supabase
    .from("signal_evidence")
    .select("wallet")
    .eq("source", "onchain_tx")
    .not("wallet", "is", null);

  const wallets = [...new Set((distinctWallets ?? []).map((r) => r.wallet as string))];
  const results: WalletScoreResult[] = [];

  for (const wallet of wallets) {
    try {
      const result = await scoreOneWallet(wallet);
      if (!result) continue;
      results.push(result);

      await supabase.from("wallet_scores").insert({
        wallet: result.wallet,
        score: result.score,
        signal_count: result.signalCount,
        trades_with_outcome: result.tradesWithOutcome,
        win_rate: result.winRate,
        avg_pnl_pct: result.avgPnlPct,
        coordinated_flag_count: result.coordinatedFlagCount,
        tenure_days: result.tenureDays,
        source: result.source,
        evidence: result.evidence,
        warnings: result.warnings,
      });
    } catch (err) {
      console.warn(`[walletScoring] failed to score ${wallet}:`, (err as Error).message);
    }
  }

  return results;
}

function formatWalletLine(r: WalletScoreResult): string {
  const short = `${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}`;
  return `\`${short}\`: *${r.score.toFixed(0)}/100* (${r.tradesWithOutcome} trades, ${r.warnings.length} warning(s))`;
}

/** Sends a Telegram digest of the top and bottom scored wallets. Call on a schedule (weekly is plenty). */
export async function sendWalletScoreDigest(): Promise<void> {
  const results = await computeAllWalletScores();
  if (results.length === 0) {
    console.log("[walletScoring] no scoreable wallets yet — skipping digest.");
    return;
  }

  const scored = results.filter((r) => r.tradesWithOutcome > 0);
  if (scored.length === 0) {
    await sendTelegramMessage(
      `*[WALLET CREDIBILITY DIGEST]*\n${results.length} wallet(s) tracked, none have a closed paper trade yet — check back once signals start resolving.`
    );
    return;
  }

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 5);
  const bottom = sorted.slice(-5).reverse();

  const message =
    `*[WALLET CREDIBILITY DIGEST]*\n` +
    `${results.length} wallet(s) scored, ${scored.length} with at least one closed trade.\n\n` +
    `Top:\n${top.map(formatWalletLine).join("\n")}\n\n` +
    `Bottom:\n${bottom.map(formatWalletLine).join("\n")}\n\n` +
    `_Full evidence/warnings for any wallet: query the wallet_scores table. Scores are traced to paper-trading outcomes, not a model guess._`;

  await sendTelegramMessage(message);
}
