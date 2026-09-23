/**
 * DISCOVERY — expands the tracked wallet list automatically.
 *
 * Callable two ways:
 *   - imported and scheduled from server.ts (the primary path — runs
 *     in-process on the always-on server, so it isn't bound by GitHub
 *     Actions' free-minute budget or scheduling delays)
 *   - `npm run discover` for a one-off manual run / CI backup
 *
 * Heuristic (intentionally simple, and intentionally NOT trusted blindly):
 *   1. Look at tokens our currently-tracked wallets bought recently.
 *   2. Pull that token's current largest holders (a free Solana RPC call —
 *      capped at the top 20 by the RPC method itself, a Solana protocol
 *      limit, not a choice made here. Getting deeper than the top 20
 *      would need a paid indexer or a source like Birdeye's top-traders
 *      endpoint; not wired up here).
 *   3. Anything that isn't already tracked, isn't a known
 *      pool/router/program address, and clears a minimum balance filter
 *      is added as a candidate.
 *
 * IMPORTANT LIMITATIONS — read before trusting this job's output:
 *   - "Largest current holders" is NOT the same as "recent skilled buyers".
 *     It will happily add a wallet that bought early and has just been
 *     holding, a wallet that received a large airdrop, or a whale that
 *     bought once and never trades again. None of that implies skill.
 *   - This can still slip through pool/vault/multisig addresses this
 *     script's KNOWN_PROGRAM_IDS list doesn't happen to cover yet.
 *   - Every auto-discovered wallet is tagged source='auto_discovered' in
 *     the DB specifically so you can filter these out of anything
 *     resembling a credibility score until a human (or a real vetting
 *     rule) has looked at them. Do not treat their future signals as
 *     equally trustworthy to seed wallets without that review.
 *
 * THE REAL CEILING IS HELIUS CREDITS, NOT THIS SCRIPT.
 * Free tier: 1M credits/month, 1 credit per webhook event delivered. If
 * tracked wallets average ~5 swaps/day between them, that's roughly
 * 6,000-7,000 wallets before you start silently losing events (Helius
 * doesn't error loudly — webhooks just stop arriving once credits run
 * out). MAX_TRACKED_WALLETS below is your guardrail against finding that
 * out the hard way. Raise it deliberately, watch your Helius dashboard
 * usage for a week after any increase, and adjust.
 */
import { supabase } from "./supabase.js";
import { KNOWN_PROGRAM_IDS } from "./types.js";
import { getTopHolderOwners } from "./solanaRpc.js";
import { recordTopTraderEntry } from "./topTraders.js";
import { fetchFreshTrendingSolanaPairs, fetchLatestBoostedSolanaTokens } from "./researchSources.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID;

// All configurable — see .env.example for the guidance on each.
const MAX_NEW_WALLETS_PER_RUN = Number(process.env.MAX_NEW_WALLETS_PER_RUN ?? 25);
const MAX_TRACKED_WALLETS = Number(process.env.MAX_TRACKED_WALLETS ?? 5000);
const MIN_HOLDER_BALANCE_FRACTION = Number(process.env.DISCOVERY_MIN_HOLDER_FRACTION ?? 0.005);
const LOOKBACK_HOURS = Number(process.env.DISCOVERY_LOOKBACK_HOURS ?? 24);

export async function refreshWebhookWithCurrentWallets(): Promise<void> {
  if (!WEBHOOK_SECRET || !WEBHOOK_URL || !WEBHOOK_ID) {
    console.warn(
      "[discover] HELIUS_WEBHOOK_ID/WEBHOOK_URL/HELIUS_WEBHOOK_SECRET not set — " +
        "new wallets were saved to the DB but the Helius webhook was NOT updated. " +
        "Run `npm run register-webhook` manually to pick them up."
    );
    return;
  }
  const { data, error } = await supabase.from("tracked_wallets").select("address");
  if (error) throw error;
  const addresses = (data ?? []).map((r) => r.address);

  const res = await fetch(`https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: WEBHOOK_URL,
      transactionTypes: ["SWAP"],
      accountAddresses: addresses,
      webhookType: "enhanced",
      authHeader: WEBHOOK_SECRET,
    }),
  });
  if (!res.ok) {
    console.error(`[discover] failed to update webhook: ${res.status} ${await res.text()}`);
    return;
  }
  console.log(`[discover] webhook updated, now covering ${addresses.length} address(es).`);
}

/**
 * Runs one discovery pass. Exported so server.ts can schedule it in-process.
 * Safe to call repeatedly — every effect (DB inserts, webhook update) is
 * idempotent or additive, and it respects MAX_TRACKED_WALLETS on every call.
 */
export async function runDiscoveryOnce(): Promise<{ added: number; skippedAtCap: boolean }> {
  if (!HELIUS_API_KEY) {
    console.error("[discover] Missing HELIUS_API_KEY env var — skipping run.");
    return { added: 0, skippedAtCap: false };
  }

  const { count: currentCount } = await supabase.from("tracked_wallets").select("*", { count: "exact", head: true });
  if ((currentCount ?? 0) >= MAX_TRACKED_WALLETS) {
    console.log(
      `[discover] at MAX_TRACKED_WALLETS (${MAX_TRACKED_WALLETS}) — skipping run. ` +
        `Raise the cap in .env if you want to keep growing (see the Helius-credit guidance in .env.example first).`
    );
    return { added: 0, skippedAtCap: true };
  }

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: recentBuys } = await supabase
    .from("raw_events")
    .select("token_mint, wallet")
    .eq("side", "buy")
    .gte("block_time", since);

  const tokensSeen = new Map<string, string>();
  for (const row of recentBuys ?? []) tokensSeen.set(row.token_mint, row.wallet);

  // If no recent buys from tracked wallets, harvest from fresh trending Solana pairs & boosted tokens (< 48h)
  if (tokensSeen.size === 0) {
    const [freshPairs, boosted] = await Promise.all([
      fetchFreshTrendingSolanaPairs().catch(() => []),
      fetchLatestBoostedSolanaTokens().catch(() => []),
    ]);

    for (const p of freshPairs) {
      if (p.baseToken?.address) tokensSeen.set(p.baseToken.address, "fresh_raydium_pool");
    }
    for (const b of boosted) {
      if (b.tokenAddress) tokensSeen.set(b.tokenAddress, "trending_breakout");
    }
  }

  if (tokensSeen.size === 0) {
    console.log("[discover] no active tokens found to expand from.");
    return { added: 0, skippedAtCap: false };
  }

  const { data: existing } = await supabase.from("tracked_wallets").select("address");
  const alreadyTracked = new Set((existing ?? []).map((r) => r.address));

  let added = 0;
  const runCap = Math.min(MAX_NEW_WALLETS_PER_RUN, MAX_TRACKED_WALLETS - (currentCount ?? 0));

  for (const [mint, fromWallet] of tokensSeen) {
    if (added >= runCap) break;

    let owners: string[] = [];
    try {
      owners = await getTopHolderOwners(mint, MIN_HOLDER_BALANCE_FRACTION);
    } catch (err) {
      console.warn(`[discover] failed to fetch top holders for ${mint}:`, (err as Error).message);
      continue;
    }

    for (const owner of owners) {
      if (added >= runCap) break;
      if (alreadyTracked.has(owner) || KNOWN_PROGRAM_IDS.has(owner)) continue;

      const { error: insertError } = await supabase.from("tracked_wallets").insert({
        address: owner,
        source: "auto_discovered",
        discovered_from_wallet: fromWallet,
        discovered_from_token: mint,
      });

      const wasAdded = !insertError;
      await supabase.from("discovery_log").insert({
        candidate_address: owner,
        discovered_from_wallet: fromWallet,
        discovered_from_token: mint,
        added: wasAdded,
        reason: wasAdded ? "top holder of a token a tracked wallet recently bought" : insertError?.message ?? "unknown",
      });

      if (wasAdded) {
        alreadyTracked.add(owner);
        added++;
        console.log(`[discover] added ${owner} (from token ${mint}, via wallet ${fromWallet})`);
        await recordTopTraderEntry({
          walletAddress: owner,
          tokenMint: mint,
          traderCategory: "top_holder",
          source: "discovery",
          notes: `Discovered from top holder of token ${mint} bought by wallet ${fromWallet}`,
        });
      }
    }
  }

  console.log(`[discover] run complete: ${added} new wallet(s) added (cap this run: ${runCap}).`);

  if (added > 0) {
    await refreshWebhookWithCurrentWallets();
  }

  return { added, skippedAtCap: false };
}

// Allow `npm run discover` / a CI job to still invoke this standalone.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runDiscoveryOnce()
    .then((result) => {
      console.log(result);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
