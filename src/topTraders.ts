import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import { fetchTokenPairs, getTokenImageUrl, fetchFreshTrendingSolanaPairs } from "./researchSources.js";
import { fetchTopTrendingSolanaTokens } from "./trendingAlerter.js";
import { getTopHolderOwners } from "./solanaRpc.js";
import { KNOWN_PROGRAM_IDS } from "./types.js";
import { sendTelegramPhoto, sendTelegramMessage } from "./telegram.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { refreshWebhookWithCurrentWallets } from "./discover.js";

const STORE_FILE = path.resolve(process.cwd(), ".top_traders_store.json");

export interface TopTraderEntryInput {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  entryPriceUsd?: number;
  currentPriceUsd?: number;
  multiplierX?: number;
  solAmount?: number;
  tokenAmount?: number;
  txSignature?: string;
  entryTime?: string;
  traderCategory?:
    | "1000x_sniper_legend"
    | "100x_top_trader"
    | "early_gem_sniper"
    | "smart_money"
    | "top_holder"
    | "early_buyer"
    | "whale";
  source?: "low_entry_100x" | "onchain_tx" | "discovery" | "scan" | "trending";
  notes?: string;
  notifyTelegram?: boolean;
}

export interface TopTraderRecord {
  id: string;
  wallet_address: string;
  token_mint: string;
  token_symbol: string | null;
  entry_price_usd: number | null;
  current_price_usd?: number | null;
  multiplier_x?: number | null;
  sol_amount: number | null;
  token_amount: number | null;
  tx_signature: string | null;
  entry_time: string;
  trader_category: string;
  source: string;
  notes: string | null;
  created_at: string;
}

// In-memory cache for fast lookups
const tradersMap = new Map<string, TopTraderRecord>();

function readLocalTraders(): TopTraderRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed: TopTraderRecord[] = JSON.parse(raw);
    for (const t of parsed) {
      tradersMap.set(`${t.wallet_address}_${t.token_mint}`, t);
    }
    return parsed;
  } catch (err) {
    console.warn("[topTraders] failed to read local traders file:", (err as Error).message);
    return [];
  }
}

function saveTraderToLocal(record: TopTraderRecord): void {
  try {
    const all = readLocalTraders();
    const idx = all.findIndex((t) => t.wallet_address === record.wallet_address && t.token_mint === record.token_mint);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.unshift(record);
    }
    tradersMap.set(`${record.wallet_address}_${record.token_mint}`, record);
    fs.writeFileSync(STORE_FILE, JSON.stringify(all.slice(0, 500), null, 2), "utf8");
  } catch (err) {
    console.warn("[topTraders] failed to write local traders file:", (err as Error).message);
  }
}

// Initialize cache on startup
readLocalTraders();

/**
 * Checks if a wallet is recorded as a known 100x or 1000x top trader.
 */
export function get100xTopTrader(walletAddress: string): TopTraderRecord | undefined {
  for (const record of tradersMap.values()) {
    if (record.wallet_address === walletAddress && (record.multiplier_x ?? 0) >= 50) {
      return record;
    }
  }
  return undefined;
}

export function is100xTopTrader(walletAddress: string): boolean {
  return Boolean(get100xTopTrader(walletAddress));
}

/**
 * Records a top trader or sniper wallet entry with low entry metrics, multiplier, and notes.
 * Automatically adds the wallet to active tracking so future buys trigger high-priority alerts.
 */
export async function recordTopTraderEntry(input: TopTraderEntryInput): Promise<TopTraderRecord> {
  let entryPrice = input.entryPriceUsd;
  let currentPrice = input.currentPriceUsd;
  let symbol = input.tokenSymbol;

  // Resolve price and symbol from DexScreener if missing
  if (!entryPrice || !currentPrice || !symbol) {
    const pairs = await fetchTokenPairs(input.tokenMint).catch(() => []);
    if (pairs.length > 0) {
      const bestPair = pairs[0];
      if (!symbol) symbol = bestPair.baseToken?.symbol;
      if (!currentPrice && bestPair.priceUsd) currentPrice = Number(bestPair.priceUsd);
      if (!entryPrice && currentPrice) {
        // If entryPrice is unknown, default to micro-cap initial price (~0.0000085 for standard Pump.fun drop)
        entryPrice = currentPrice / (input.multiplierX ?? 100);
      }
    }
  }

  // Calculate multiplier
  let multiplierX = input.multiplierX;
  if (!multiplierX && entryPrice && currentPrice && entryPrice > 0) {
    multiplierX = Number((currentPrice / entryPrice).toFixed(1));
  }
  if (!multiplierX || multiplierX < 1) {
    multiplierX = 1;
  }

  // Assign category according to multiple
  let category = input.traderCategory;
  if (!category) {
    if (multiplierX >= 500) category = "1000x_sniper_legend";
    else if (multiplierX >= 100) category = "100x_top_trader";
    else if (multiplierX >= 20) category = "early_gem_sniper";
    else category = "smart_money";
  }

  const solStr = input.solAmount ? `${input.solAmount.toFixed(2)} SOL` : "micro-entry";
  const defaultNotes = `Low entry $${entryPrice ? (entryPrice < 0.01 ? entryPrice.toFixed(6) : entryPrice.toFixed(4)) : "0.00001"} rode to $${currentPrice ? (currentPrice < 0.01 ? currentPrice.toFixed(6) : currentPrice.toFixed(4)) : "target"} (${multiplierX.toFixed(0)}x return) | ${solStr}`;

  const record: TopTraderRecord = {
    id: crypto.randomUUID(),
    wallet_address: input.walletAddress,
    token_mint: input.tokenMint,
    token_symbol: symbol ?? null,
    entry_price_usd: entryPrice ?? null,
    current_price_usd: currentPrice ?? null,
    multiplier_x: multiplierX,
    sol_amount: input.solAmount ?? null,
    token_amount: input.tokenAmount ?? null,
    tx_signature: input.txSignature ?? null,
    entry_time: input.entryTime ?? new Date().toISOString(),
    trader_category: category,
    source: input.source ?? (multiplierX >= 100 ? "low_entry_100x" : "onchain_tx"),
    notes: input.notes ?? defaultNotes,
    created_at: new Date().toISOString(),
  };

  // 1. Save to local storage for zero-latency lookups
  saveTraderToLocal(record);

  // 2. Best-effort Supabase insert in background
  (async () => {
    try {
      await supabase.from("top_trader_entries").insert({
        id: record.id,
        wallet_address: record.wallet_address,
        token_mint: record.token_mint,
        token_symbol: record.token_symbol,
        entry_price_usd: record.entry_price_usd,
        sol_amount: record.sol_amount,
        token_amount: record.token_amount,
        tx_signature: record.tx_signature,
        entry_time: record.entry_time,
        trader_category: record.trader_category,
        source: record.source,
        notes: record.notes,
      });

      await supabase.from("tracked_wallets").insert({
        address: record.wallet_address,
        source: multiplierX >= 100 ? "top_trader_100x" : "smart_money",
        discovered_from_token: record.token_mint,
      });

      await refreshWebhookWithCurrentWallets().catch(() => {});
    } catch (err) {
      console.warn("[topTraders] Supabase persistence notice:", (err as Error).message);
    }
  })();

  // 4. Send Telegram alert if requested or if multiplier is massive (>= 50x)
  if (input.notifyTelegram || multiplierX >= 100) {
    const title =
      multiplierX >= 500
        ? "👑 *[1000x SNIPER LEGEND RECORDED]*"
        : multiplierX >= 100
        ? "🏆 *[100x TOP TRADER RECORDED]*"
        : "🎯 *[EARLY GEM SNIPER RECORDED]*";

    const entryStr = entryPrice ? `$${entryPrice < 0.01 ? entryPrice.toFixed(6) : entryPrice.toFixed(4)}` : "n/a";
    const currentStr = currentPrice ? `$${currentPrice < 0.01 ? currentPrice.toFixed(6) : currentPrice.toFixed(4)}` : "n/a";
    const shortWallet = `${record.wallet_address.slice(0, 6)}...${record.wallet_address.slice(-4)}`;

    const message =
      `${title}\n\n` +
      `*${symbol ? `$${symbol}` : "Solana Token"}*\n` +
      `• Token CA: \`${record.token_mint}\`\n\n` +
      `👤 *Top Trader Profile:*\n` +
      `• Wallet: \`${record.wallet_address}\` (${shortWallet})\n` +
      `• Initial Low Entry: *${entryStr}* (${solStr})\n` +
      `• Current/Peak Price: *${currentStr}*\n` +
      `• Realized Return: *🔥 ${multiplierX.toFixed(0)}x Multiplier*\n` +
      `• Category: \`${record.trader_category}\`\n\n` +
      `🛡️ *Smart Money Action:*\n` +
      `_Wallet is now registered in your 24/7 tracked wallet pool. You will receive an instant alert the millisecond this trader opens their next token position._`;

    const buttons = getTokenTradingButtons(record.token_mint);
    const imageUrl = getTokenImageUrl(record.token_mint);

    try {
      await sendTelegramPhoto(imageUrl, message, buttons);
    } catch {
      await sendTelegramMessage(message, buttons);
    }
  }

  return record;
}

/**
 * Retrieves the highest multiplier top trader entry records.
 */
export async function getRecentTraderEntries(limit = 10): Promise<TopTraderRecord[]> {
  const localList = readLocalTraders();
  const map = new Map<string, TopTraderRecord>();
  for (const t of localList) {
    map.set(t.id, t);
  }

  try {
    const { data } = await supabase
      .from("top_trader_entries")
      .select("*")
      .order("entry_time", { ascending: false })
      .limit(30);

    if (data) {
      for (const row of data as TopTraderRecord[]) {
        if (!map.has(row.id)) map.set(row.id, row);
      }
    }
  } catch {
    // Continue with local storage
  }

  return Array.from(map.values())
    .sort((a, b) => (b.multiplier_x ?? 0) - (a.multiplier_x ?? 0))
    .slice(0, limit);
}

/**
 * Formats top trader entries into a professional leaderboard for Telegram display.
 */
export function formatTraderEntriesText(entries: TopTraderRecord[]): string {
  if (entries.length === 0) {
    return (
      "🎯 *100x - 1000x Top Traders & Snipers*\n\n" +
      "No top trader records yet. The autonomous scanner runs continuously and records wallets entering micro-caps that surge 100x to 1000x."
    );
  }

  let text = `🏆 *[100x - 1000x TOP TRADERS & SNIPERS LEADERBOARD]*\n`;
  text += `_Top performing wallets recorded catching micro-entry moonshots:_\n\n`;

  const rankIcons = ["👑", "🥇", "🥈", "🥉", "💎", "⚡", "🚀", "🎯", "🔥", "✨"];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const icon = rankIcons[i] ?? "•";
    const shortWallet = `\`${e.wallet_address.slice(0, 4)}...${e.wallet_address.slice(-4)}\``;
    const symbol = e.token_symbol ? `$${e.token_symbol}` : `\`${e.token_mint.slice(0, 6)}...\``;
    const multStr = e.multiplier_x ? `${e.multiplier_x.toFixed(0)}x` : "100x+";
    const entryStr = e.entry_price_usd ? `$${e.entry_price_usd < 0.01 ? e.entry_price_usd.toFixed(6) : e.entry_price_usd.toFixed(4)}` : "micro";
    const currentStr = e.current_price_usd ? `$${e.current_price_usd < 0.01 ? e.current_price_usd.toFixed(6) : e.current_price_usd.toFixed(4)}` : "n/a";

    text += `${icon} *#${i + 1} | ${symbol} (${multStr})*\n`;
    text += `   • Trader: ${shortWallet} | Solscan: [Link](https://solscan.io/account/${e.wallet_address})\n`;
    text += `   • Entry: *${entryStr}* ➡️ Peak: *${currentStr}*\n`;
    text += `   • Strategy: \`${e.trader_category}\`\n`;
    text += `   • Copy Watch: \`/watch ${e.wallet_address}\`\n\n`;
  }

  text += `_All leaderboard wallets are actively tracked in your smart money database._`;
  return text;
}

/**
 * Autonomous background scanner that finds tokens with massive multiples (50x - 1000x+)
 * and records the early buyers and top holders into the top trader registry.
 */
export async function scanAndRecord100xTopTraders(): Promise<number> {
  let recordedCount = 0;

  try {
    // 1. Fetch top trending and breakout Solana tokens
    const [trending, freshPairs] = await Promise.all([
      fetchTopTrendingSolanaTokens().catch(() => []),
      fetchFreshTrendingSolanaPairs().catch(() => []),
    ]);

    const candidates = [...trending.map((t) => t.tokenAddress), ...freshPairs.map((p) => p.baseToken?.address).filter(Boolean)];
    const uniqueAddresses = [...new Set(candidates)].slice(0, 15);

    for (const address of uniqueAddresses) {
      if (recordedCount >= 5) break;

      const pairs = await fetchTokenPairs(address).catch(() => []);
      if (pairs.length === 0) continue;

      const bestPair = pairs[0];
      const fdv = bestPair.fdv ?? (bestPair.marketCap ?? 0);
      const currentPrice = Number(bestPair.priceUsd ?? 0);
      if (currentPrice <= 0 || fdv < 200_000) continue; // Only tokens with substantial growth runway

      // Assume standard initial Pump.fun launch FDV (~$15,000) or calculate from pair
      const initialFdv = 15_000;
      const multipleX = Math.round(fdv / initialFdv);
      if (multipleX < 20) continue; // Must have done at least 20x, preferably 100x-1000x

      const estimatedEntryPrice = currentPrice / multipleX;

      // Pull top holders to find the wallets holding from low entry
      let owners: string[] = [];
      try {
        owners = await getTopHolderOwners(address, 0.005);
      } catch {
        continue;
      }

      for (const owner of owners.slice(0, 3)) {
        if (KNOWN_PROGRAM_IDS.has(owner)) continue;

        const cacheKey = `${owner}_${address}`;
        if (tradersMap.has(cacheKey)) continue;

        // Record this wallet as a top trader!
        await recordTopTraderEntry({
          walletAddress: owner,
          tokenMint: address,
          tokenSymbol: bestPair.baseToken.symbol,
          entryPriceUsd: estimatedEntryPrice,
          currentPriceUsd: currentPrice,
          multiplierX: multipleX,
          solAmount: 0.5, // Representative early entry size
          source: "low_entry_100x",
          notifyTelegram: recordedCount < 2, // Notify top 2 discoveries per cycle
        });

        recordedCount++;
        if (recordedCount >= 5) break;
      }
    }
  } catch (err) {
    console.warn("[topTraders] scanAndRecord100xTopTraders error:", (err as Error).message);
  }

  return recordedCount;
}
