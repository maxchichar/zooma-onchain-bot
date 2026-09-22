/**
 * On-demand paper-trading report. Same numbers as the scheduled Telegram
 * digest, but runnable anytime and to stdout instead of waiting for the
 * next digest interval.
 *
 * Usage:
 *   npm run report               # 7/30/90-day windows, all categories
 *   npm run report -- 14         # single custom window, all categories
 *   npm run report -- 30 nft_watch
 */
import { computeStats, Category } from "./paperTrading.js";

async function main() {
  const args = process.argv.slice(2);
  const windowDays = args[0] ? Number(args[0]) : null;
  const category = (args[1] as Category | undefined) ?? undefined;

  const windows = windowDays ? [windowDays] : [7, 30, 90];

  for (const days of windows) {
    const stats = await computeStats(days, category);
    console.log(`\n--- Last ${days} days${category ? ` (${category})` : ""} ---`);
    console.log(JSON.stringify(stats, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
