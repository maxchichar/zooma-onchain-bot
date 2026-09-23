import { supabase } from "./supabase.js";
import { fetchTokenPairs } from "./researchSources.js";

export interface TopTraderEntryInput {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  entryPriceUsd?: number;
  solAmount?: number;
  tokenAmount?: number;
  txSignature?: string;
  entryTime?: string;
  traderCategory?: "smart_money" | "top_holder" | "early_buyer" | "whale";
  source?: "onchain_tx" | "discovery" | "scan" | "trending";
  notes?: string;
}

export interface TopTraderRecord {
  id: string;
  wallet_address: string;
  token_mint: string;
  token_symbol: string | null;
  entry_price_usd: number | null;
  sol_amount: number | null;
  token_amount: number | null;
  tx_signature: string | null;
  entry_time: string;
  trader_category: string;
  source: string;
  notes: string | null;
  created_at: string;
}

/**
 * Records a top trader or smart money wallet entry with price, size, and timestamp.
 * Fails gracefully and logs a warning if database table is pending migration.
 */
export async function recordTopTraderEntry(input: TopTraderEntryInput): Promise<void> {
  try {
    let entryPrice = input.entryPriceUsd;
    let symbol = input.tokenSymbol;

    // If price or symbol missing, best-effort fetch from DexScreener
    if (!entryPrice || !symbol) {
      const pairs = await fetchTokenPairs(input.tokenMint).catch(() => []);
      if (pairs.length > 0) {
        const bestPair = pairs[0];
        if (!symbol) symbol = bestPair.baseToken?.symbol;
        if (!entryPrice && bestPair.priceUsd) entryPrice = Number(bestPair.priceUsd);
      }
    }

    const row = {
      wallet_address: input.walletAddress,
      token_mint: input.tokenMint,
      token_symbol: symbol ?? null,
      entry_price_usd: entryPrice ?? null,
      sol_amount: input.solAmount ?? null,
      token_amount: input.tokenAmount ?? null,
      tx_signature: input.txSignature ?? null,
      entry_time: input.entryTime ?? new Date().toISOString(),
      trader_category: input.traderCategory ?? "smart_money",
      source: input.source ?? "onchain_tx",
      notes: input.notes ?? null,
    };

    const { error } = await supabase.from("top_trader_entries").insert(row);
    if (error) {
      // If table doesn't exist yet, log reminder
      if (error.code === "42P01") {
        console.warn("[topTraders] table top_trader_entries does not exist yet. Run schema_migration_006_top_traders.sql in Supabase SQL editor.");
      } else {
        console.error("[topTraders] failed to record top trader entry:", error.message);
      }
    }
  } catch (err) {
    console.error("[topTraders] error in recordTopTraderEntry:", (err as Error).message);
  }
}

/**
 * Retrieves the most recent top trader entry records.
 */
export async function getRecentTraderEntries(limit = 10): Promise<TopTraderRecord[]> {
  try {
    const { data, error } = await supabase
      .from("top_trader_entries")
      .select("*")
      .order("entry_time", { ascending: false })
      .limit(limit);

    if (error) {
      console.warn("[topTraders] getRecentTraderEntries:", error.message);
      return [];
    }
    return (data as TopTraderRecord[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * Formats recent recorded trader entries for Telegram display.
 */
export function formatTraderEntriesText(entries: TopTraderRecord[]): string {
  if (entries.length === 0) {
    return "No top trader entries recorded yet. As tracked wallets execute swaps or new smart wallets are discovered, their exact entries will appear here.";
  }

  let text = `🎯 *Recent Top Trader & Smart Money Entries*\n\n`;
  for (const e of entries) {
    const shortWallet = `\`${e.wallet_address.slice(0, 4)}...${e.wallet_address.slice(-4)}\``;
    const symbol = e.token_symbol ? `$${e.token_symbol}` : `\`${e.token_mint.slice(0, 6)}...\``;
    const priceStr = e.entry_price_usd ? `$${e.entry_price_usd < 0.01 ? e.entry_price_usd.toFixed(6) : e.entry_price_usd.toFixed(4)}` : "n/a";
    const solStr = e.sol_amount ? `${e.sol_amount.toFixed(2)} SOL` : "";
    const timeStr = new Date(e.entry_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

    text += `• ${shortWallet} bought *${symbol}*\n`;
    text += `  💵 Entry: *${priceStr}* ${solStr ? `(${solStr})` : ""} | 🕒 ${timeStr}\n`;
    text += `  🏷️ Type: _${e.trader_category}_ (${e.source})\n\n`;
  }

  return text;
}
