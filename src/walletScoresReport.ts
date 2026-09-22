/**
 * Full wallet credibility report, on demand — every scored wallet with
 * its complete evidence and warnings, not just the top/bottom 5 the
 * Telegram digest sends.
 *
 * Usage: npm run wallet-scores
 */
import { computeAllWalletScores } from "./walletScoring.js";

async function main() {
  const results = await computeAllWalletScores();
  if (results.length === 0) {
    console.log("No scoreable wallets yet — a wallet needs at least one signal with signal_evidence to be scored.");
    return;
  }

  const sorted = [...results].sort((a, b) => b.score - a.score);
  for (const r of sorted) {
    console.log(`\n${r.wallet} — ${r.score.toFixed(1)}/100`);
    console.log(`  signals: ${r.signalCount}, closed trades: ${r.tradesWithOutcome}, source: ${r.source ?? "unknown"}`);
    if (r.winRate !== null) console.log(`  win rate: ${(r.winRate * 100).toFixed(0)}%, avg PnL: ${r.avgPnlPct?.toFixed(1)}%`);
    for (const e of r.evidence) console.log(`  + ${e}`);
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
