import { supabase } from "./supabase.js";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.js";
import { HeliusEnhancedTx, ParsedLeg, WRAPPED_SOL_MINT } from "./types.js";
import { classifyAccumulationPattern, AccumulationClassification } from "./jev.js";
import { explainSignal } from "./llm.js";
import { openPaperTrade } from "./paperTrading.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import { fetchTokenPairs, getTokenImageUrl } from "./researchSources.js";
import { recordTopTraderEntry } from "./topTraders.js";
import { evaluateTokenRugRisk } from "./rugRisk.js";

const ACCUMULATION_THRESHOLD = Number(process.env.ACCUMULATION_THRESHOLD ?? 3);
const ACCUMULATION_WINDOW_MINUTES = Number(process.env.ACCUMULATION_WINDOW_MINUTES ?? 120);
const SIGNAL_COOLDOWN_HOURS = Number(process.env.SIGNAL_COOLDOWN_HOURS ?? 6);

/**
 * Turns one Helius enhanced transaction into zero or more (wallet, buy/sell)
 * legs, but ONLY for wallets we're actually tracking. Same simple-swap-only
 * logic as the Phase 0 script, for the same reason: an undercount from
 * skipping multi-hop/ambiguous transactions is safer than guessing.
 */
export function extractTrackedLegs(tx: HeliusEnhancedTx, trackedWallets: Set<string>): ParsedLeg[] {
  const legs: ParsedLeg[] = [];
  const nativeTransfers = tx.nativeTransfers ?? [];
  const tokenTransfers = tx.tokenTransfers ?? [];

  const involvedWallets = new Set<string>();
  for (const t of nativeTransfers) {
    if (trackedWallets.has(t.fromUserAccount)) involvedWallets.add(t.fromUserAccount);
    if (trackedWallets.has(t.toUserAccount)) involvedWallets.add(t.toUserAccount);
  }
  for (const t of tokenTransfers) {
    if (trackedWallets.has(t.fromUserAccount)) involvedWallets.add(t.fromUserAccount);
    if (trackedWallets.has(t.toUserAccount)) involvedWallets.add(t.toUserAccount);
  }

  for (const wallet of involvedWallets) {
    let netLamports = 0;
    for (const t of nativeTransfers) {
      if (t.toUserAccount === wallet) netLamports += t.amount;
      if (t.fromUserAccount === wallet) netLamports -= t.amount;
    }
    const netSol = netLamports / 1e9;

    const tokenMoves = tokenTransfers.filter(
      (t) => t.mint !== WRAPPED_SOL_MINT && (t.toUserAccount === wallet || t.fromUserAccount === wallet)
    );
    const distinctMints = new Set(tokenMoves.map((t) => t.mint));
    if (distinctMints.size !== 1 || Math.abs(netSol) < 1e-6) continue; // skip ambiguous, same as Phase 0

    const mint = [...distinctMints][0];
    const tokenAmount = tokenMoves.reduce(
      (sum, t) => sum + (t.toUserAccount === wallet ? t.tokenAmount : -t.tokenAmount),
      0
    );

    if (tokenAmount > 0 && netSol < 0) {
      legs.push({ wallet, signature: tx.signature, timestamp: tx.timestamp, mint, side: "buy", tokenAmount, solAmount: Math.abs(netSol) });
    } else if (tokenAmount < 0 && netSol > 0) {
      legs.push({ wallet, signature: tx.signature, timestamp: tx.timestamp, mint, side: "sell", tokenAmount: Math.abs(tokenAmount), solAmount: netSol });
    }
  }

  return legs;
}

/** Persists a parsed leg (idempotent — safe to call twice for the same webhook retry). */
async function saveEvent(leg: ParsedLeg): Promise<void> {
  const { error } = await supabase.from("raw_events").upsert(
    {
      signature: leg.signature,
      wallet: leg.wallet,
      token_mint: leg.mint,
      side: leg.side,
      token_amount: leg.tokenAmount,
      sol_amount: leg.solAmount,
      block_time: new Date(leg.timestamp * 1000).toISOString(),
    },
    { onConflict: "signature,wallet" }
  );
  if (error) console.error("[signalEngine] failed to save event:", error.message);
}

/**
 * Checks whether an existing, still-fresh signal of this type already
 * exists for this token — the anti-spam guard your brief asked for.
 * Returns true if we should SKIP firing (cooldown active).
 */
async function isInCooldown(tokenMint: string, signalType: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - SIGNAL_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenMint)
    .eq("signal_type", signalType)
    .gte("created_at", cutoff)
    .limit(1);

  if (error) {
    console.error("[signalEngine] cooldown check failed, defaulting to SKIP to be safe:", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

async function fireSignal(
  tokenMint: string,
  signalType: string,
  evidenceSignatures: { signature: string; wallet: string }[],
  details: Record<string, unknown>,
  explanation: string | null
): Promise<void> {
  const { data: signal, error } = await supabase
    .from("signals")
    .insert({ token_mint: tokenMint, signal_type: signalType, status: "UNVALIDATED", details })
    .select()
    .single();

  if (error || !signal) {
    console.error("[signalEngine] failed to insert signal:", error?.message);
    return;
  }

  const evidenceRows = evidenceSignatures.map((e) => ({
    signal_id: signal.id,
    signature: e.signature,
    wallet: e.wallet,
  }));
  const { error: evError } = await supabase.from("signal_evidence").insert(evidenceRows);
  if (evError) console.error("[signalEngine] failed to insert evidence:", evError.message);

  const walletList = evidenceSignatures.map((e) => `\`${e.wallet.slice(0, 6)}...${e.wallet.slice(-4)}\``).join(", ");

  const jevRead = details.jev_read as AccumulationClassification | null;
  const jevLine = jevRead
    ? `\n• Pattern AI: *${jevRead.pattern}* (${(jevRead.confidence * 100).toFixed(0)}% confidence)`
    : "";

  const body = explanation
    ? explanation.trim()
    : `${evidenceSignatures.length} smart money wallet(s) accumulated this token within the time window.`;

  const pairs = await fetchTokenPairs(tokenMint).catch(() => []);
  const pair = pairs.length > 0 ? pairs[0] : undefined;
  const imageUrl = getTokenImageUrl(tokenMint, pair);
  const rugAudit = await evaluateTokenRugRisk(tokenMint, { liquidityUsd: pair?.liquidity?.usd });

  const symbolLine = pair?.baseToken?.symbol ? `• Symbol: *$${pair.baseToken.symbol}* | DEX: *${pair.dexId}*\n` : "";
  const marketLine = pair?.priceUsd ? `• Price: *$${pair.priceUsd}* | Liq: *$${Math.round(pair.liquidity?.usd ?? 0).toLocaleString()}*\n` : "";

  const message =
    `🎯 *[ALERT] Smart Money Accumulation*\n\n` +
    `• Token CA: \`${tokenMint}\`\n` +
    symbolLine +
    marketLine +
    `\n📋 *Pattern Analysis:*\n` +
    `${body}${jevLine}\n\n` +
    `🛡️ *Rug Risk Audit:* ${rugAudit.verdict}\n` +
    `👥 *Tracked Buyers:* ${walletList}\n` +
    `🧾 *Evidence:* ${evidenceSignatures.length} confirmed on-chain transaction(s)\n\n` +
    `_Rule-triggered signal. Not financial advice._`;

  await sendTelegramPhoto(imageUrl, message, getTokenTradingButtons(tokenMint));

  // Every fired signal opens a simulated position automatically — this
  // is what lets us eventually answer "would this have made money"
  // instead of just "did the pattern match." Best-effort: a failure here
  // must never affect the signal itself, which is already recorded.
  try {
    await openPaperTrade(signal.id, tokenMint, "wallet_pattern");
  } catch (err) {
    console.error("[signalEngine] failed to open paper trade:", (err as Error).message);
  }
}

/**
 * Core rule: if >= ACCUMULATION_THRESHOLD distinct tracked wallets bought
 * the same token within the trailing ACCUMULATION_WINDOW_MINUTES, fire an
 * ACCUMULATION signal (subject to cooldown). Deliberately the ONLY rule
 * wired up right now — start narrow, add DISTRIBUTION/WATCH rules only
 * once this one has been observed against real data for a while.
 */
async function checkAccumulation(tokenMint: string): Promise<void> {
  const windowStart = new Date(Date.now() - ACCUMULATION_WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data: events, error } = await supabase
    .from("raw_events")
    .select("wallet, signature, sol_amount, token_amount, block_time")
    .eq("token_mint", tokenMint)
    .eq("side", "buy")
    .gte("block_time", windowStart);

  if (error) {
    console.error("[signalEngine] failed to query window:", error.message);
    return;
  }

  // One representative row per distinct wallet (evidence + JEV/LLM input).
  const byWallet = new Map<string, { signature: string; sol_amount: number; token_amount: number; block_time: string }>();
  for (const e of events ?? []) if (!byWallet.has(e.wallet)) byWallet.set(e.wallet, e);

  if (byWallet.size < ACCUMULATION_THRESHOLD) return;
  if (await isInCooldown(tokenMint, "ACCUMULATION")) return;

  const evidence = [...byWallet.entries()].map(([wallet, e]) => ({ wallet, signature: e.signature }));

  // JEV: advisory classification only — does NOT gate whether we notify.
  const jevRead = await classifyAccumulationPattern({
    tokenMint,
    buys: [...byWallet.entries()].map(([wallet, e]) => ({
      wallet,
      solAmount: Number(e.sol_amount),
      tokenAmount: Number(e.token_amount),
      timestamp: Math.floor(new Date(e.block_time).getTime() / 1000),
    })),
  });

  // LLM: turns the already-computed facts (rule result + JEV read) into a
  // short explanation. Given nothing it could invent details from.
  const explanation = await explainSignal({
    tokenMint,
    signalType: "ACCUMULATION",
    walletCount: byWallet.size,
    windowMinutes: ACCUMULATION_WINDOW_MINUTES,
    jevRead: jevRead ? { pattern: jevRead.pattern, confidence: jevRead.confidence } : null,
    evidenceCount: evidence.length,
  });

  await fireSignal(
    tokenMint,
    "ACCUMULATION",
    evidence,
    {
      distinct_wallet_count: byWallet.size,
      window_minutes: ACCUMULATION_WINDOW_MINUTES,
      jev_read: jevRead,
    },
    explanation
  );
}

/** Entry point called by the webhook handler for every incoming transaction. */
export async function processTransaction(tx: HeliusEnhancedTx, trackedWallets: Set<string>): Promise<void> {
  const legs = extractTrackedLegs(tx, trackedWallets);
  const affectedMints = new Set<string>();

  for (const leg of legs) {
    await saveEvent(leg);
    if (leg.side === "buy") {
      affectedMints.add(leg.mint);
      await recordTopTraderEntry({
        walletAddress: leg.wallet,
        tokenMint: leg.mint,
        solAmount: leg.solAmount,
        tokenAmount: leg.tokenAmount,
        txSignature: leg.signature,
        entryTime: new Date(leg.timestamp * 1000).toISOString(),
        traderCategory: "smart_money",
        source: "onchain_tx",
      });
    }
  }

  for (const mint of affectedMints) {
    await checkAccumulation(mint);
  }
}
