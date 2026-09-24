/**
 * Raw data-source fetchers for the research module. Kept separate from
 * research.ts's filtering/scoring logic so each source can be tested or
 * swapped independently.
 *
 * SOURCES AND WHY THEY'RE THE $0 CHOICE:
 *
 * DexScreener - free, no API key, no auth. Confirmed rate limits: ~300
 * req/min for pair/token data, ~60 req/min for profile/boost endpoints.
 * Used for meme coin discovery (newly boosted/profiled tokens) and for
 * checking a token's real liquidity/volume (boosted != liquid).
 *
 * LunarCrush - free tier exists but is rate-limited and requires an API
 * key (sign up at lunarcrush.com). This is the X-adjacent data source:
 * it aggregates social activity FROM X/Reddit/YouTube into a derived
 * score (Galaxy Score, social volume) rather than exposing raw posts.
 * Called sparingly (once per research cycle per candidate, not per
 * request) to respect the free tier. Every call is try/caught - a
 * missing or rate-limited LunarCrush read just means a candidate gets
 * evaluated without a social score, not a failed run.
 *
 * Magic Eden - free public reads on the Solana API, no key required
 * (documented at 120 requests/min). Used for NFT collection discovery.
 * The exact endpoint used here (`/v2/collections` + `/v2/collections/
 * {symbol}/stats`) is the one confirmed in Magic Eden's own API
 * reference (docs.magiceden.io) - there may be a more direct "trending"
 * endpoint; worth checking their current docs if you want to cut down
 * the number of calls this makes.
 */

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const MAGICEDEN_BASE = "https://api-mainnet.magiceden.dev/v2";
const LUNARCRUSH_API_KEY = process.env.LUNARCRUSH_API_KEY;

// ---------- DexScreener ----------

export interface DexScreenerBoostedToken {
  chainId: string;
  tokenAddress: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
  txns?: { h24?: { buys: number; sells: number } };
  pairCreatedAt?: number; // unix ms
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: Array<{ label?: string; url: string }>;
    socials?: Array<{ type?: string; url: string }>;
  };
}

const tokenImageCache = new Map<string, string>();

export function getTokenImageUrl(mint: string, pair?: DexScreenerPair): string {
  if (pair?.info?.imageUrl) return pair.info.imageUrl;
  if (tokenImageCache.has(mint)) return tokenImageCache.get(mint)!;
  return `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`;
}

export async function resolvePumpTokenImageUrl(uri?: string, mint?: string): Promise<string> {
  if (mint && tokenImageCache.has(mint)) {
    return tokenImageCache.get(mint)!;
  }

  if (uri) {
    try {
      if (/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(uri)) {
        if (mint) tokenImageCache.set(mint, uri);
        return uri;
      }

      let fetchUrl = uri;
      if (fetchUrl.includes("/ipfs/")) {
        const hash = fetchUrl.split("/ipfs/")[1];
        fetchUrl = `https://pump.mypinata.cloud/ipfs/${hash}`;
      } else if (fetchUrl.startsWith("ipfs://")) {
        const hash = fetchUrl.replace("ipfs://", "");
        fetchUrl = `https://pump.mypinata.cloud/ipfs/${hash}`;
      }

      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.image) {
          let img = String(data.image);
          if (img.includes("/ipfs/")) {
            const hash = img.split("/ipfs/")[1];
            img = `https://pump.mypinata.cloud/ipfs/${hash}`;
          } else if (img.startsWith("ipfs://")) {
            const hash = img.replace("ipfs://", "");
            img = `https://pump.mypinata.cloud/ipfs/${hash}`;
          }
          if (mint) tokenImageCache.set(mint, img);
          return img;
        }
      }
    } catch {
      // fallback
    }
  }

  if (mint) {
    const fallback = `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`;
    tokenImageCache.set(mint, fallback);
    return fallback;
  }
  return "assets/zooma_logo.png";
}

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[researchSources] ${url} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[researchSources] fetch failed for ${url}:`, (err as Error).message);
    return null;
  }
}

/** Recently boosted (paid-promotion) tokens, filtered to Solana. Raw discovery, not vetted. */
export async function fetchLatestBoostedSolanaTokens(): Promise<DexScreenerBoostedToken[]> {
  const data = await safeFetchJson<DexScreenerBoostedToken[]>(`${DEXSCREENER_BASE}/token-boosts/latest/v1`);
  return (data ?? []).filter((t) => t.chainId === "solana");
}

/** Recently created token profile pages, filtered to Solana. Raw discovery, not vetted. */
export async function fetchLatestSolanaTokenProfiles(): Promise<DexScreenerBoostedToken[]> {
  const data = await safeFetchJson<DexScreenerBoostedToken[]>(`${DEXSCREENER_BASE}/token-profiles/latest/v1`);
  return (data ?? []).filter((t) => t.chainId === "solana");
}

/** Fresh active Solana pairs from Raydium and DEX search. */
export async function fetchFreshTrendingSolanaPairs(): Promise<DexScreenerPair[]> {
  const [raydiumRes, solanaRes] = await Promise.all([
    safeFetchJson<{ pairs: DexScreenerPair[] | null }>(`${DEXSCREENER_BASE}/latest/dex/search?q=raydium`),
    safeFetchJson<{ pairs: DexScreenerPair[] | null }>(`${DEXSCREENER_BASE}/latest/dex/search?q=solana`),
  ]);

  const all = [...(raydiumRes?.pairs ?? []), ...(solanaRes?.pairs ?? [])];
  const solanaOnly = all.filter((p) => p.chainId === "solana" && p.baseToken?.address);

  // Deduplicate by baseToken.address
  const seen = new Set<string>();
  const unique: DexScreenerPair[] = [];
  for (const p of solanaOnly) {
    if (!seen.has(p.baseToken.address)) {
      seen.add(p.baseToken.address);
      unique.push(p);
    }
  }
  return unique;
}

/** Active Meteora DLMM and Dynamic AMM Solana pairs. */
export async function fetchMeteoraSolanaPairs(): Promise<DexScreenerPair[]> {
  const res = await safeFetchJson<{ pairs: DexScreenerPair[] | null }>(
    `${DEXSCREENER_BASE}/latest/dex/search?q=meteora`
  );
  const pairs = res?.pairs ?? [];
  return pairs.filter((p) => p.chainId === "solana" && p.dexId?.toLowerCase().includes("meteora"));
}

/** Active Moonshot Launchpad Solana pairs. */
export async function fetchMoonshotSolanaPairs(): Promise<DexScreenerPair[]> {
  const res = await safeFetchJson<{ pairs: DexScreenerPair[] | null }>(
    `${DEXSCREENER_BASE}/latest/dex/search?q=moonshot`
  );
  const pairs = res?.pairs ?? [];
  return pairs.filter((p) => p.chainId === "solana" && p.dexId?.toLowerCase().includes("moonshot"));
}

/** Cross-channel scanner: aggregates live pairs across Meteora, Raydium, Moonshot, and multi-DEX. */
export async function fetchMultiChannelSolanaPairs(): Promise<DexScreenerPair[]> {
  const [fresh, meteora, moonshot] = await Promise.all([
    fetchFreshTrendingSolanaPairs().catch(() => []),
    fetchMeteoraSolanaPairs().catch(() => []),
    fetchMoonshotSolanaPairs().catch(() => []),
  ]);

  const seen = new Set<string>();
  const combined: DexScreenerPair[] = [];

  for (const p of [...meteora, ...moonshot, ...fresh]) {
    if (p.baseToken?.address && !seen.has(p.baseToken.address)) {
      seen.add(p.baseToken.address);
      combined.push(p);
    }
  }
  return combined;
}

/** Real market data (liquidity, volume, age) for a token: this is what actually gates a candidate. */
export async function fetchTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
  const data = await safeFetchJson<{ pairs: DexScreenerPair[] | null }>(
    `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenAddress}`
  );
  return data?.pairs ?? [];
}

// ---------- LunarCrush ----------

export interface SocialTopicSummary {
  galaxyScore: number | null;
  socialVolume: number | null;
  altRank: number | null;
}

/**
 * Best-effort social score for a token symbol. Returns null on any
 * failure (no key, rate limited, unknown topic): callers must treat a
 * missing social score as normal, not an error.
 */
export async function fetchSocialScore(symbol: string): Promise<SocialTopicSummary | null> {
  if (!LUNARCRUSH_API_KEY) return null;

  try {
    const res = await fetch(`https://lunarcrush.com/api4/public/topic/${symbol.toLowerCase()}/v1`, {
      headers: { Authorization: `Bearer ${LUNARCRUSH_API_KEY}` },
    });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[researchSources] LunarCrush ${symbol} -> ${res.status}`);
      return null;
    }
    const json = await res.json();
    const d = json?.data ?? {};
    return {
      galaxyScore: typeof d.galaxy_score === "number" ? d.galaxy_score : null,
      socialVolume: typeof d.social_volume === "number" ? d.social_volume : null,
      altRank: typeof d.alt_rank === "number" ? d.alt_rank : null,
    };
  } catch (err) {
    console.warn(`[researchSources] LunarCrush fetch failed for ${symbol}:`, (err as Error).message);
    return null;
  }
}

// ---------- Magic Eden ----------

export interface MagicEdenCollection {
  symbol: string;
  name: string;
}

export interface MagicEdenCollectionStats {
  symbol: string;
  floorPrice: number | null; // lamports
  listedCount: number | null;
  volumeAll: number | null; // lamports, cumulative - used relative to a prior snapshot, not absolute
}

/** A page of Solana collections. Not sorted by trending - research.ts ranks these itself via stats. */
export async function fetchCollectionsPage(offset: number, limit: number): Promise<MagicEdenCollection[]> {
  const data = await safeFetchJson<MagicEdenCollection[]>(
    `${MAGICEDEN_BASE}/collections?offset=${offset}&limit=${limit}`
  );
  return data ?? [];
}

export async function fetchCollectionStats(symbol: string, timeWindow: "24h" | "7d" = "24h"): Promise<MagicEdenCollectionStats | null> {
  const data = await safeFetchJson<{ floorPrice?: number; listedCount?: number; volumeAll?: number }>(
    `${MAGICEDEN_BASE}/collections/${symbol}/stats?timeWindow=${timeWindow}`
  );
  if (!data) return null;
  return {
    symbol,
    floorPrice: data.floorPrice ?? null,
    listedCount: data.listedCount ?? null,
    volumeAll: data.volumeAll ?? null,
  };
}
