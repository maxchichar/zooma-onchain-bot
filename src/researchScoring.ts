/**
 * RESEARCH SIGNAL SCORING — the meme-coin/NFT equivalent of wallet
 * credibility scoring, covering the gap wallet scoring can't: a token or
 * NFT collection is a one-off, not a reusable entity like a wallet, so
 * there's nothing analogous to "score this wallet" to compute here.
 * What DOES persist and repeat across every meme coin / NFT signal is
 * the JEV risk classification (`looks_organic` -> `classic_rug_setup`)
 * and the discovery category itself — so THOSE are what gets scored:
 * is JEV's risk read for this category actually predictive of paper
 * trading outcomes, or not?
 *
 * This is deliberately a calibration check, not a vanity metric. If
 * `classic_rug_setup`-flagged tokens have BETTER average paper-trade
 * returns than `looks_organic`-flagged ones, that's a real, useful,
 * slightly uncomfortable finding — it means the JEV risk read for this
 * category isn't earning its place in the alert yet, and the honest
 * thing to do is say so, not hide it.
 *
 * Same non-negotiables as wallet scoring: every number here traces to
 * actual closed paper trades, sample sizes are shown and used to
 * discount confidence (never hidden), and nothing here is itself a
 * model output — it's arithmetic over data JEV/the rule engine already
 * produced.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessage } from "./telegram.js";

const MIN_TRADES_FOR_NOTE = 10; // below this, results get an explicit small-sample warning

export type ResearchCategory = "meme_coin_watch" | "nft_watch";

export interface ResearchScoreBucket {
  category: ResearchCategory;
  jevLevel: string | null; // null = no JEV read available for these trades
  tradesWithOutcome: number;
  winRate: number | null;
  avgPnlPct: number | null;
  evidence: string[];
  warnings: string[];
}

interface ClosedTradeRow {
  signal_id: string;
  category: ResearchCategory;
  pnl_pct: number;
}

async function loadClosedResearchTrades(): Promise<ClosedTradeRow[]> {
  const { data, error } = await supabase
    .from("paper_trades")
    .select("signal_id, category, pnl_pct")
    .eq("status", "closed")
    .in("category", ["meme_coin_watch", "nft_watch"]);
  if (error) {
    console.error("[researchScoring] failed to load closed trades:", error.message);
    return [];
  }
  return (data ?? []) as ClosedTradeRow[];
}

async function loadJevLevels(signalIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (signalIds.length === 0) return map;

  const { data, error } = await supabase.from("signals").select("id, details").in("id", signalIds);
  if (error) {
    console.error("[researchScoring] failed to load signal details:", error.message);
    return map;
  }
  for (const s of data ?? []) {
    const level = (s.details as any)?.jev_read?.level ?? null;
    map.set(s.id, level);
  }
  return map;
}

function summarizeBucket(category: ResearchCategory, jevLevel: string | null, trades: number[]): ResearchScoreBucket {
  const tradesWithOutcome = trades.length;
  const wins = trades.filter((p) => p > 0).length;
  const winRate = tradesWithOutcome > 0 ? wins / tradesWithOutcome : null;
  const avgPnlPct = tradesWithOutcome > 0 ? trades.reduce((s, p) => s + p, 0) / tradesWithOutcome : null;

  const evidence: string[] = [];
  const warnings: string[] = [];

  if (tradesWithOutcome > 0) {
    evidence.push(`${tradesWithOutcome} closed trade(s), ${wins} profitable (${(winRate! * 100).toFixed(0)}% win rate)`);
    evidence.push(`Average PnL: ${avgPnlPct! >= 0 ? "+" : ""}${avgPnlPct!.toFixed(1)}%`);
  } else {
    warnings.push("No closed trades yet for this bucket");
  }
  if (tradesWithOutcome > 0 && tradesWithOutcome < MIN_TRADES_FOR_NOTE) {
    warnings.push(`Small sample (${tradesWithOutcome} trade(s)) — treat this bucket's numbers as preliminary`);
  }
  if (jevLevel === null) {
    warnings.push("These trades have no JEV read (JEV not configured or the call failed at signal time)");
  }

  return { category, jevLevel, tradesWithOutcome, winRate, avgPnlPct, evidence, warnings };
}

/** Recomputes and stores scores for every (category, JEV level) bucket with at least one closed trade. */
export async function computeResearchScores(): Promise<ResearchScoreBucket[]> {
  const closedTrades = await loadClosedResearchTrades();
  if (closedTrades.length === 0) return [];

  const signalIds = [...new Set(closedTrades.map((t) => t.signal_id))];
  const jevLevels = await loadJevLevels(signalIds);

  // Group by (category, jevLevel).
  const groups = new Map<string, { category: ResearchCategory; jevLevel: string | null; pnls: number[] }>();
  for (const trade of closedTrades) {
    const level = jevLevels.get(trade.signal_id) ?? null;
    const key = `${trade.category}::${level}`;
    if (!groups.has(key)) groups.set(key, { category: trade.category, jevLevel: level, pnls: [] });
    groups.get(key)!.pnls.push(Number(trade.pnl_pct));
  }

  const buckets: ResearchScoreBucket[] = [];
  for (const { category, jevLevel, pnls } of groups.values()) {
    const bucket = summarizeBucket(category, jevLevel, pnls);
    buckets.push(bucket);

    const { error } = await supabase.from("research_signal_scores").insert({
      category: bucket.category,
      jev_level: bucket.jevLevel,
      trades_with_outcome: bucket.tradesWithOutcome,
      win_rate: bucket.winRate,
      avg_pnl_pct: bucket.avgPnlPct,
      evidence: bucket.evidence,
      warnings: bucket.warnings,
    });
    if (error) console.error("[researchScoring] failed to store bucket:", error.message);
  }

  return buckets;
}

function formatBucketLine(b: ResearchScoreBucket): string {
  const label = b.jevLevel ? b.jevLevel.replace(/_/g, " ") : "no JEV read";
  const winRateStr = b.winRate !== null ? `${(b.winRate * 100).toFixed(0)}%` : "n/a";
  const pnlStr = b.avgPnlPct !== null ? `${b.avgPnlPct >= 0 ? "+" : ""}${b.avgPnlPct.toFixed(1)}%` : "n/a";
  return `  ${label}: ${b.tradesWithOutcome} trades, ${winRateStr} win rate, avg ${pnlStr}`;
}

/**
 * Sends a digest showing, per category, whether JEV's risk read is
 * actually calibrated against paper-trading outcomes. Call on a
 * schedule (weekly, alongside the wallet score digest).
 */
export async function sendResearchScoreDigest(): Promise<void> {
  const buckets = await computeResearchScores();
  if (buckets.length === 0) {
    console.log("[researchScoring] no closed research trades yet — skipping digest.");
    return;
  }

  const byCategory: Record<string, ResearchScoreBucket[]> = {};
  for (const b of buckets) {
    byCategory[b.category] = byCategory[b.category] ?? [];
    byCategory[b.category].push(b);
  }

  // JEV level ordering for readability: best-case to worst-case.
  const levelOrder = ["looks_organic", "some_red_flags", "multiple_red_flags", "classic_rug_setup", "null"];
  const sortKey = (b: ResearchScoreBucket) => levelOrder.indexOf(b.jevLevel ?? "null");

  const sections = Object.entries(byCategory).map(([category, bs]) => {
    const sorted = [...bs].sort((a, b) => sortKey(a) - sortKey(b));
    return `*${category}*:\n${sorted.map(formatBucketLine).join("\n")}`;
  });

  // Flag if the calibration looks inverted (higher-risk bucket outperforming a lower-risk one) —
  // this is the actually-actionable finding, so it's called out explicitly rather than left for
  // someone to notice by eyeballing the numbers.
  const calibrationWarnings: string[] = [];
  for (const [category, bs] of Object.entries(byCategory)) {
    const organic = bs.find((b) => b.jevLevel === "looks_organic" && b.tradesWithOutcome >= MIN_TRADES_FOR_NOTE);
    const rug = bs.find((b) => b.jevLevel === "classic_rug_setup" && b.tradesWithOutcome >= MIN_TRADES_FOR_NOTE);
    if (organic && rug && (rug.avgPnlPct ?? -Infinity) > (organic.avgPnlPct ?? Infinity)) {
      calibrationWarnings.push(
        `⚠️ ${category}: "classic_rug_setup" trades outperformed "looks_organic" trades (JEV risk calibration adjustment needed).`
      );
    }
  }

  const message =
    `*[RESEARCH SIGNAL SCORING DIGEST]*\n` +
    `Is JEV's risk read actually predictive for meme coins/NFTs? Here's what the paper trades show:\n\n` +
    `${sections.join("\n\n")}\n\n` +
    (calibrationWarnings.length > 0 ? `${calibrationWarnings.join("\n")}\n\n` : "") +
    `_Buckets under ${MIN_TRADES_FOR_NOTE} trades are preliminary. Full history: query research_signal_scores._`;

  await sendTelegramMessage(message);
}
