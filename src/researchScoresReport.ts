/**
 * Full research signal scoring report, on demand.
 * Usage: npm run research-scores
 */
import { computeResearchScores } from "./researchScoring.js";

async function main() {
  const buckets = await computeResearchScores();
  if (buckets.length === 0) {
    console.log("No closed research (meme coin/NFT) trades yet — nothing to score.");
    return;
  }

  for (const b of buckets) {
    console.log(`\n${b.category} / JEV level: ${b.jevLevel ?? "(no read)"}`);
    console.log(`  trades: ${b.tradesWithOutcome}, win rate: ${b.winRate !== null ? (b.winRate * 100).toFixed(0) + "%" : "n/a"}, avg PnL: ${b.avgPnlPct?.toFixed(1) ?? "n/a"}%`);
    for (const e of b.evidence) console.log(`  + ${e}`);
    for (const w of b.warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
