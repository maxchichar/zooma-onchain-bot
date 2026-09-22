export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

// Well-known Solana program IDs that show up as "top holders" of a token
// but are pools/routers/vaults, not wallets with trading behavior. The
// discovery job excludes these so it doesn't "discover" a Raydium pool
// and start treating it like a smart trader.
// NOTE: verify these against a current Solana program registry (e.g.
// Solscan's "Verified Programs" list) before relying on them — program
// IDs for AMMs/routers do get added to over time (new Raydium pool types,
// new aggregator versions, etc.), and this seed list will go stale. Treat
// it as a starting point to expand, not a complete or guaranteed-current
// filter.
export const KNOWN_PROGRAM_IDS = new Set<string>([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium Liquidity Pool V4
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter Aggregator v6
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpools
  "11111111111111111111111111111111111111111",   // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token Program
]);

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusEnhancedTx {
  signature: string;
  timestamp: number; // unix seconds
  type: string;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
}

export interface ParsedLeg {
  wallet: string;
  signature: string;
  timestamp: number;
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
}
