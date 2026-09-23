/**
 * RESEARCH — surfaces meme coins and NFT collections getting unusual
 * market/social attention, as a separate discovery path from the
 * tracked-wallet accumulation signal in signalEngine.ts.
 *
 * Same non-negotiables as the rest of this bot:
 *   - deterministic filters (real liquidity/volume, not just "boosted")
 *     decide whether a candidate surfaces at all — JEV/LLM only enrich
 *   - every candidate is tagged UNVALIDATED and category-labeled so it's
 *     never confused with a backtested result
 *   - every alert traces to specific source data (a pair address, a
 *     collection symbol, a numeric metric), never a vibe
 *
 * EXTRA CAUTION FOR THIS MODULE SPECIFICALLY: meme coins and NFTs are the
 * highest-scam-density corner of on-chain activity. "Boosted on
 * DexScreener" and "high social score" are things a scammer pays for on
 * purpose. The holder-concentration check below is a real but limited
 * rug-risk filter — it catches obvious cases, not sophisticated ones.
 * Treat everything this module surfaces as a starting point for your own
 * research, not a vetted opportunity.
 */
import { supabase } from "./supabase.js";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.js";
import { classifyTokenRisk } from "./jev.js";
import { explainResearchCandidate } from "./llm.js";
import { getTopHolderConcentration } from "./solanaRpc.js";
import { checkMintAuthorities, checkDeployerHistory } from "./rugRisk.js";
import { openPaperTrade } from "./paperTrading.js";
import { getTokenTradingButtons } from "./tradeLinks.js";
import {
  fetchLatestBoostedSolanaTokens,
  fetchLatestSolanaTokenProfiles,
  fetchTokenPairs,
  fetchSocialScore,
  fetchCollectionsPage,
  fetchCollectionStats,
  getTokenImageUrl,
} from "./researchSources.js";

const MIN_LIQUIDITY_USD = Number(process.env.RESEARCH_MIN_LIQUIDITY_USD ?? 5000);
const MIN_VOLUME_24H_USD = Number(process.env.RESEARCH_MIN_VOLUME_24H_USD ?? 10000);
const MEME_COIN_COOLDOWN_HOURS = Number(process.env.MEME_COIN_COOLDOWN_HOURS ?? 12);
const MAX_MEME_CANDIDATES_PER_RUN = Number(process.env.MAX_MEME_CANDIDATES_PER_RUN ?? 10);

const NFT_SAMPLE_SIZE = Number(process.env.NFT_SAMPLE_SIZE ?? 40);
const NFT_VOLUME_SPIKE_PCT = Number(process.env.NFT_VOLUME_SPIKE_PCT ?? 25); // % change vs prior snapshot
const NFT_COOLDOWN_HOURS = Number(process.env.NFT_COOLDOWN_HOURS ?? 24);

async function isInCooldown(tokenOrSymbol: string, category: string, cooldownHours: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownHours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("signals")
    .select("id")
    .eq("token_mint", tokenOrSymbol)
    .eq("category", category)
    .gte("created_at", cutoff)
    .limit(1);
  if (error) {
    console.error("[research] cooldown check failed, defaulting to SKIP:", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

async function fireResearchSignal(params: {
  tokenOrSymbol: string;
  category: "meme_coin_watch" | "nft_watch";
  details: Record<string, unknown>;
  evidence: { source: string; reference: string; note: string }[];
  explanation: string | null;
  headline: string;
}): Promise<void> {
  const { data: signal, error } = await supabase
    .from("signals")
    .insert({
      token_mint: params.tokenOrSymbol,
      signal_type: "WATCH",
      category: params.category,
      status: "UNVALIDATED",
      details: params.details,
    })
    .select()
    .single();

  if (error || !signal) {
    console.error("[research] failed to insert signal:", error?.message);
    return;
  }

  const evidenceRows = params.evidence.map((e) => ({
    signal_id: signal.id,
    source: e.source,
    reference: e.reference,
    note: e.note,
  }));
  const { error: evError } = await supabase.from("signal_evidence").insert(evidenceRows);
  if (evError) console.error("[research] failed to insert evidence:", evError.message);

  const jevRead = params.details.jev_read as { level: string; confidence: number } | null;
  const jevLine = jevRead
    ? `\nJEV risk read: *${jevRead.level.replace(/_/g, " ")}* (confidence ${(jevRead.confidence * 100).toFixed(0)}%) — a model classification, not proof.`
    : "";

  const body = params.explanation
    ? params.explanation.trim()
    : `${params.headline} — rule-based detection, no AI explanation available for this alert.`;

  const evidenceLines = params.evidence.map((e) => `- ${e.source}: ${e.note}`).join("\n");

  const message =
    `*[UNVALIDATED] [RESEARCH] WATCH*\n` +
    `${params.category === "meme_coin_watch" ? "Token" : "Collection"}: \`${params.tokenOrSymbol}\`\n\n` +
    `${body}${jevLine}\n\n` +
    `Evidence:\n${evidenceLines}\n\n` +
    `_High-risk category (meme coin / NFT). Not backtested. Not financial advice._`;

  const buttons =
    params.category === "nft_watch"
      ? [[{ text: "🌊 Magic Eden", url: `https://magiceden.io/marketplace/${params.tokenOrSymbol}` }]]
      : getTokenTradingButtons(params.tokenOrSymbol);

  if (params.category === "meme_coin_watch") {
    const imageUrl = getTokenImageUrl(params.tokenOrSymbol);
    await sendTelegramPhoto(imageUrl, message, buttons);
  } else {
    await sendTelegramMessage(message, buttons);
  }

  try {
    await openPaperTrade(signal.id, params.tokenOrSymbol, params.category);
  } catch (err) {
    console.error("[research] failed to open paper trade:", (err as Error).message);
  }
}

// ---------- Meme coin discovery ----------

async function evaluateMemeCoinCandidate(tokenAddress: string): Promise<void> {
  const pairs = await fetchTokenPairs(tokenAddress);
  if (pairs.length === 0) return;

  // Use the highest-liquidity pair as the representative one.
  const pair = pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best), pairs[0]);

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;
  if (liquidityUsd < MIN_LIQUIDITY_USD || volume24hUsd < MIN_VOLUME_24H_USD) return; // real filter, not just "boosted"

  if (await isInCooldown(tokenAddress, "meme_coin_watch", MEME_COIN_COOLDOWN_HOURS)) return;

  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const topHolderPct = await getTopHolderConcentration(tokenAddress).then((f) => (f !== null ? f * 100 : null));
  const social = await fetchSocialScore(pair.baseToken.symbol);
  const mintAuthorities = await checkMintAuthorities(tokenAddress);
  const deployerHistory = await checkDeployerHistory(tokenAddress);

  const jevRead = await classifyTokenRisk({
    tokenMint: tokenAddress,
    liquidityUsd,
    volume24hUsd,
    ageHours,
    topHolderPct,
    socialGalaxyScore: social?.galaxyScore ?? null,
    mintAuthorityRenounced: mintAuthorities?.mintAuthorityRenounced ?? null,
    freezeAuthorityRenounced: mintAuthorities?.freezeAuthorityRenounced ?? null,
    deployerOtherTokensFound: deployerHistory?.otherTokensFound ?? null,
    deployerLikelyAbandonedCount: deployerHistory?.likelyAbandonedCount ?? null,
  });

  const explanation = await explainResearchCandidate({
    category: "meme_coin_watch",
    tokenOrCollection: `${pair.baseToken.symbol} (${tokenAddress})`,
    metrics: {
      liquidityUsd,
      volume24hUsd,
      ageHours: Number(ageHours.toFixed(1)),
      topHolderPct,
      social,
      mintAuthorities,
      deployerHistory: deployerHistory
        ? { otherTokensFound: deployerHistory.otherTokensFound, likelyAbandonedCount: deployerHistory.likelyAbandonedCount }
        : null,
    },
    jevRead: jevRead ? { level: jevRead.level, confidence: jevRead.confidence } : null,
  });

  const rugRiskEvidence: { source: string; reference: string; note: string }[] = [];
  if (mintAuthorities) {
    if (!mintAuthorities.mintAuthorityRenounced) {
      rugRiskEvidence.push({ source: "solana_rpc", reference: tokenAddress, note: "⚠ mint authority NOT renounced — deployer can create more supply" });
    }
    if (!mintAuthorities.freezeAuthorityRenounced) {
      rugRiskEvidence.push({ source: "solana_rpc", reference: tokenAddress, note: "⚠ freeze authority NOT renounced — deployer can freeze holder wallets" });
    }
  }
  if (deployerHistory && deployerHistory.likelyAbandonedCount > 0) {
    rugRiskEvidence.push({
      source: "helius_history",
      reference: deployerHistory.deployer,
      note: `⚠ deployer has ${deployerHistory.otherTokensFound} other token(s) found, ${deployerHistory.likelyAbandonedCount} now near-zero liquidity (heuristic, examples: ${deployerHistory.abandonedExamples.join(", ") || "n/a"})`,
    });
  }

  await fireResearchSignal({
    tokenOrSymbol: tokenAddress,
    category: "meme_coin_watch",
    headline: `${pair.baseToken.symbol}: $${Math.round(liquidityUsd).toLocaleString()} liquidity, $${Math.round(volume24hUsd).toLocaleString()} 24h volume`,
    details: {
      symbol: pair.baseToken.symbol,
      liquidity_usd: liquidityUsd,
      volume_24h_usd: volume24hUsd,
      age_hours: ageHours,
      top_holder_pct: topHolderPct,
      social,
      mint_authorities: mintAuthorities,
      deployer_history: deployerHistory,
      jev_read: jevRead,
    },
    evidence: [
      { source: "dexscreener", reference: pair.url, note: `liquidity $${Math.round(liquidityUsd)}, 24h vol $${Math.round(volume24hUsd)}` },
      ...(topHolderPct !== null ? [{ source: "solana_rpc", reference: tokenAddress, note: `top holder owns ~${topHolderPct.toFixed(1)}% of top-20 sample` }] : []),
      ...(social ? [{ source: "lunarcrush", reference: pair.baseToken.symbol, note: `galaxy score ${social.galaxyScore ?? "n/a"}` }] : []),
      ...rugRiskEvidence,
    ],
    explanation,
  });
}

export async function runMemeCoinResearch(): Promise<void> {
  const [boosted, profiles] = await Promise.all([fetchLatestBoostedSolanaTokens(), fetchLatestSolanaTokenProfiles()]);
  const candidates = [...new Set([...boosted, ...profiles].map((t) => t.tokenAddress))].slice(0, MAX_MEME_CANDIDATES_PER_RUN);

  for (const tokenAddress of candidates) {
    try {
      await evaluateMemeCoinCandidate(tokenAddress);
    } catch (err) {
      console.warn(`[research] meme coin evaluation failed for ${tokenAddress}:`, (err as Error).message);
    }
  }
}

// ---------- NFT discovery ----------

async function getPriorVolumeSnapshot(symbol: string): Promise<number | null> {
  const { data } = await supabase
    .from("nft_collection_snapshots")
    .select("volume_all")
    .eq("symbol", symbol)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number(data.volume_all) : null;
}

export async function runNftResearch(): Promise<void> {
  const collections = await fetchCollectionsPage(0, NFT_SAMPLE_SIZE);

  for (const { symbol } of collections) {
    try {
      const stats = await fetchCollectionStats(symbol, "24h");
      if (!stats || stats.volumeAll === null) continue;

      const priorVolume = await getPriorVolumeSnapshot(symbol);

      // Always store the snapshot so next run has a comparison point,
      // regardless of whether this run fires an alert.
      await supabase.from("nft_collection_snapshots").insert({
        symbol,
        volume_all: stats.volumeAll,
        floor_price: stats.floorPrice,
      });

      if (priorVolume === null || priorVolume === 0) continue; // no baseline yet, nothing to compare
      const changePct = ((stats.volumeAll - priorVolume) / priorVolume) * 100;
      if (changePct < NFT_VOLUME_SPIKE_PCT) continue;

      if (await isInCooldown(symbol, "nft_watch", NFT_COOLDOWN_HOURS)) continue;

      const jevRead = await classifyTokenRisk({
        tokenMint: symbol,
        liquidityUsd: 0, // not applicable to NFTs; JEV prompt is generic enough to still be informative on the other fields
        volume24hUsd: stats.volumeAll,
        ageHours: 0,
        topHolderPct: null,
        socialGalaxyScore: null,
        // Mint/freeze authority and deployer-history checks are SPL-token
        // specific (rugRisk.ts) and don't apply to NFT collections.
        mintAuthorityRenounced: null,
        freezeAuthorityRenounced: null,
        deployerOtherTokensFound: null,
        deployerLikelyAbandonedCount: null,
      });

      const explanation = await explainResearchCandidate({
        category: "nft_watch",
        tokenOrCollection: symbol,
        metrics: { volumeAllLamports: stats.volumeAll, priorVolumeLamports: priorVolume, changePct: Number(changePct.toFixed(1)), floorPriceLamports: stats.floorPrice },
        jevRead: jevRead ? { level: jevRead.level, confidence: jevRead.confidence } : null,
      });

      await fireResearchSignal({
        tokenOrSymbol: symbol,
        category: "nft_watch",
        headline: `${symbol}: volume up ${changePct.toFixed(0)}% vs prior snapshot`,
        details: { volume_all: stats.volumeAll, prior_volume: priorVolume, change_pct: changePct, floor_price: stats.floorPrice, jev_read: jevRead },
        evidence: [
          { source: "magiceden", reference: symbol, note: `volume ${priorVolume} -> ${stats.volumeAll} lamports (${changePct.toFixed(0)}%)` },
        ],
        explanation,
      });
    } catch (err) {
      console.warn(`[research] NFT evaluation failed for ${symbol}:`, (err as Error).message);
    }
  }
}

export async function runResearchOnce(): Promise<void> {
  await runMemeCoinResearch();
  await runNftResearch();
}
