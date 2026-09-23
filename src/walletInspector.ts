import { supabase } from "./supabase.js";
import { getWalletSolBalance } from "./solanaRpc.js";
import { computeAllWalletScores, WalletScoreResult } from "./walletScoring.js";
import { TelegramButton } from "./telegram.js";

/**
 * Returns a unique high-resolution visual identicon avatar for any Solana wallet.
 */
export function getWalletIdenticonUrl(wallet: string): string {
  return `https://api.dicebear.com/7.x/identicon/png?seed=${wallet}&backgroundColor=0f172a,1e293b,020617`;
}

export interface DetailedWalletProfile {
  address: string;
  source: string;
  addedAt: string;
  solBalance: number | null;
  scoreData: WalletScoreResult | null;
  totalEventsRecorded: number;
  recentTokens: { mint: string; side: string; solAmount: number; blockTime: string }[];
}

/**
 * Gathers complete real-time intelligence on a tracked or candidate wallet.
 */
export async function inspectWalletDetail(wallet: string): Promise<DetailedWalletProfile> {
  const [balance, dbWallet, events, scores] = await Promise.all([
    getWalletSolBalance(wallet).catch(() => null),
    supabase.from("tracked_wallets").select("*").eq("address", wallet).maybeSingle(),
    supabase
      .from("raw_events")
      .select("token_mint, side, sol_amount, block_time")
      .eq("wallet", wallet)
      .order("block_time", { ascending: false })
      .limit(5),
    computeAllWalletScores().catch(() => []),
  ]);

  const scoreData = scores.find((s) => s.wallet === wallet) ?? null;

  const { count: totalEvents } = await supabase
    .from("raw_events")
    .select("*", { count: "exact", head: true })
    .eq("wallet", wallet);

  return {
    address: wallet,
    source: dbWallet.data?.source ?? "manual_lookup",
    addedAt: dbWallet.data?.added_at ?? new Date().toISOString(),
    solBalance: balance,
    scoreData,
    totalEventsRecorded: totalEvents ?? 0,
    recentTokens: (events.data ?? []).map((e) => ({
      mint: e.token_mint,
      side: e.side,
      solAmount: Number(e.sol_amount),
      blockTime: e.block_time,
    })),
  };
}

/**
 * Formats a comprehensive wallet profile report.
 */
export function formatWalletDetailText(p: DetailedWalletProfile): string {
  const solText = p.solBalance !== null ? `${p.solBalance.toFixed(3)} SOL` : "Unknown";
  const scoreVal = p.scoreData ? `${p.scoreData.score.toFixed(0)}/100` : "Unranked (needs closed trades)";
  const winRate = p.scoreData?.winRate !== null && p.scoreData?.winRate !== undefined ? `${(p.scoreData.winRate * 100).toFixed(0)}%` : "n/a";
  const avgPnl = p.scoreData?.avgPnlPct !== null && p.scoreData?.avgPnlPct !== undefined ? `${p.scoreData.avgPnlPct >= 0 ? "+" : ""}${p.scoreData.avgPnlPct.toFixed(1)}%` : "n/a";

  let tierBadge = "🌱 New Trader";
  if (p.scoreData && p.scoreData.score >= 75) tierBadge = "🏆 Top Tier Smart Money";
  else if (p.scoreData && p.scoreData.score >= 50) tierBadge = "⭐ Consistent Trader";
  else if (p.scoreData && p.scoreData.tradesWithOutcome > 0) tierBadge = "📊 Active Trader";

  let tokensSection = "";
  if (p.recentTokens.length > 0) {
    tokensSection = `\n🔄 *Recent Activity:*\n`;
    for (const t of p.recentTokens) {
      const shortMint = `\`${t.mint.slice(0, 4)}...${t.mint.slice(-4)}\``;
      const action = t.side.toUpperCase();
      tokensSection += `• ${action} ${shortMint} (${t.solAmount.toFixed(2)} SOL)\n`;
    }
  }

  return (
    `👤 *Smart Money Wallet Dossier*\n\n` +
    `• Address: \`${p.address}\`\n` +
    `• Tier: *${tierBadge}*\n` +
    `• Balance: *${solText}*\n` +
    `• Source: _${p.source}_\n\n` +
    `📊 *Performance Analytics:*\n` +
    `• Credibility Score: *${scoreVal}*\n` +
    `• Win Rate: *${winRate}* | Avg PnL: *${avgPnl}*\n` +
    `• Resolved Trades: *${p.scoreData?.tradesWithOutcome ?? 0}*\n` +
    `• Total Recorded Swaps: *${p.totalEventsRecorded}*` +
    tokensSection +
    `\n⚡ *Explore portfolio & history:*`
  );
}

/**
 * Fast external profile buttons for deep wallet diligence.
 */
export function getWalletProfileButtons(wallet: string): TelegramButton[][] {
  return [
    [
      { text: "🔍 Solscan Explorer", url: `https://solscan.io/account/${wallet}` },
      { text: "🐸 GMGN Portfolio", url: `https://gmgn.ai/sol/address/${wallet}` },
    ],
    [
      { text: "⚡ Cielo Tracker", url: `https://app.cielo.finance/profile/${wallet}` },
      { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${wallet}` },
    ],
  ];
}
