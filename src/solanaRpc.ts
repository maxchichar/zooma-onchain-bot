const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = () =>
  HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : "https://api.mainnet-beta.solana.com";

export async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

export interface LargestAccount {
  address: string;
  amount: string;
}

/**
 * Fraction (0-1) of the top-20 holder sample held by the single largest
 * holder: a cheap, free rug-concentration proxy. Note this is over the
 * top 20 only (a Solana RPC protocol cap, not a choice made here), so it
 * understates concentration for tokens with many more than 20 holders of
 * any size. Returns null on any RPC failure rather than throwing.
 */
export async function getTopHolderConcentration(mint: string): Promise<number | null> {
  try {
    const result = await rpcCall<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint]);
    const accounts = (result?.value ?? []).slice(0, 20);
    if (accounts.length === 0) return null;
    const total = accounts.reduce((s, a) => s + Number(a.amount), 0);
    if (total === 0) return null;

    const firstFraction = Number(accounts[0].amount) / total;
    // If account 0 holds > 40% of supply, it is almost always the AMM pool vault (Raydium / PumpSwap).
    // In that case, evaluate the largest individual holder (account 1) relative to circulating supply.
    if (firstFraction > 0.40 && accounts.length > 1) {
      const circulating = total - Number(accounts[0].amount);
      if (circulating > 0) {
        return Number(accounts[1].amount) / circulating;
      }
    }

    return firstFraction;
  } catch (err) {
    console.warn(`[solanaRpc] holder concentration check failed for ${mint}:`, (err as Error).message);
    return null;
  }
}

/** Resolves top-20 token-account holders of a mint down to their owning wallet addresses. */
export async function getTopHolderOwners(mint: string, minFraction: number): Promise<string[]> {
  const result = await rpcCall<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint]);
  const tokenAccounts = (result?.value ?? []).slice(0, 20);
  if (tokenAccounts.length === 0) return [];

  const total = tokenAccounts.reduce((s, a) => s + Number(a.amount), 0);
  const significant = tokenAccounts.filter((a) => total > 0 && Number(a.amount) / total >= minFraction);

  const accountInfos = await rpcCall<{ value: ({ owner: string; data: { parsed: { info: { owner: string } } } } | null)[] }>(
    "getMultipleAccounts",
    [significant.map((a) => a.address), { encoding: "jsonParsed" }]
  );

  const owners = (accountInfos?.value ?? [])
    .map((info) => info?.data?.parsed?.info?.owner)
    .filter((owner): owner is string => Boolean(owner));

  return [...new Set(owners)];
}

/** Fetches real-time SOL balance for any wallet address. */
export async function getWalletSolBalance(wallet: string): Promise<number | null> {
  try {
    const result = await rpcCall<{ value: number }>("getBalance", [wallet]);
    if (typeof result?.value === "number") {
      return result.value / 1e9; // lamports to SOL
    }
    return null;
  } catch {
    return null;
  }
}

export interface HolderDistribution {
  top1Pct: number;
  top10Pct: number;
  isAmmReserveDetected: boolean;
  ammReservePct?: number;
}

/**
 * Returns deep holder distribution metrics including top 1 and top 10 non-AMM holders.
 */
export async function getDetailedHolderDistribution(mint: string): Promise<HolderDistribution | null> {
  try {
    const result = await rpcCall<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint]);
    const accounts = (result?.value ?? []).slice(0, 20);
    if (accounts.length === 0) return null;
    const total = accounts.reduce((s, a) => s + Number(a.amount), 0);
    if (total === 0) return null;

    const firstAmt = Number(accounts[0].amount);
    const firstFraction = firstAmt / total;
    const isAmmReserve = firstFraction > 0.40 && accounts.length > 1;

    let nonAmmAccounts = accounts;
    let circulatingSupply = total;

    if (isAmmReserve) {
      nonAmmAccounts = accounts.slice(1);
      circulatingSupply = total - firstAmt;
    }

    if (nonAmmAccounts.length === 0 || circulatingSupply <= 0) return null;

    const top1 = (Number(nonAmmAccounts[0].amount) / circulatingSupply) * 100;
    const top10Total = nonAmmAccounts.slice(0, 10).reduce((s, a) => s + Number(a.amount), 0);
    const top10 = (top10Total / circulatingSupply) * 100;

    return {
      top1Pct: Number(top1.toFixed(1)),
      top10Pct: Number(top10.toFixed(1)),
      isAmmReserveDetected: isAmmReserve,
      ammReservePct: isAmmReserve ? Number((firstFraction * 100).toFixed(1)) : undefined,
    };
  } catch (err) {
    console.warn(`[solanaRpc] detailed holder distribution failed for ${mint}:`, (err as Error).message);
    return null;
  }
}

