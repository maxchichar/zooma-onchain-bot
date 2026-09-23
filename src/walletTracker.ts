/**
 * ACTIVE ON-CHAIN WALLET TRACKER
 * Continuously polls tracked smart-money wallets on Solana for recent swaps via Helius API.
 * Ensures the bot detects whale moves, accumulation, and opens simulated paper trades
 * even when inbound webhooks are delayed or offline.
 */
import { supabase } from "./supabase.js";
import { processTransaction } from "./signalEngine.js";
import { HeliusEnhancedTx } from "./types.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WALLET_POLL_BATCH_SIZE = Number(process.env.WALLET_POLL_BATCH_SIZE ?? 10);

const seenSignatures = new Set<string>();
const MAX_SEEN_SIGNATURES = 5000;

let walletRotationIndex = 0;

/**
 * Polls a batch of tracked wallets for their most recent SWAP transactions.
 * Returns the count of newly parsed and processed transactions.
 */
export async function pollTrackedWalletsActivity(): Promise<number> {
  if (!HELIUS_API_KEY) {
    console.warn("[walletTracker] HELIUS_API_KEY missing - skipping active wallet poll.");
    return 0;
  }

  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("address")
    .order("added_at", { ascending: false });

  if (error || !wallets || wallets.length === 0) {
    return 0;
  }

  const allWallets = wallets.map((w) => w.address);
  const trackedSet = new Set(allWallets);

  // Rotate through wallets in batches
  const batchStart = walletRotationIndex % allWallets.length;
  const batch = allWallets.slice(batchStart, batchStart + WALLET_POLL_BATCH_SIZE);
  if (batch.length < WALLET_POLL_BATCH_SIZE && allWallets.length > WALLET_POLL_BATCH_SIZE) {
    batch.push(...allWallets.slice(0, WALLET_POLL_BATCH_SIZE - batch.length));
  }
  walletRotationIndex = (batchStart + WALLET_POLL_BATCH_SIZE) % allWallets.length;

  let newTxCount = 0;

  for (const wallet of batch) {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP`;
      const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
      if (!res.ok) continue;

      const txs = (await res.json()) as HeliusEnhancedTx[];
      if (!Array.isArray(txs) || txs.length === 0) continue;

      // Filter for recent swaps not seen in memory
      for (const tx of txs.slice(0, 5)) {
        if (!tx.signature || seenSignatures.has(tx.signature)) continue;

        seenSignatures.add(tx.signature);
        if (seenSignatures.size > MAX_SEEN_SIGNATURES) {
          const oldest = seenSignatures.values().next().value;
          if (oldest) seenSignatures.delete(oldest);
        }

        // Check if already in raw_events
        const { data: existing } = await supabase
          .from("raw_events")
          .select("signature")
          .eq("signature", tx.signature)
          .limit(1);

        if (existing && existing.length > 0) continue;

        // Process transaction on-chain
        await processTransaction(tx, trackedSet);
        newTxCount++;
      }
    } catch (err) {
      console.warn(`[walletTracker] error polling wallet ${wallet}:`, (err as Error).message);
    }
  }

  return newTxCount;
}
