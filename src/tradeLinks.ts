import { TelegramButton } from "./telegram.js";

/**
 * Returns fast-trading and terminal links for any Solana token mint address.
 * Includes sub-second trading terminals (Photon, BullX, GMGN), Telegram sniping bots (Trojan),
 * aggregators (Jupiter), and analytics (DexScreener, Solscan).
 */
export function getTokenTradingButtons(tokenMint: string): TelegramButton[][] {
  return [
    [
      { text: "⚡ Photon", url: `https://photon-sol.tinyastro.io/en/lp/${tokenMint}` },
      { text: "🐂 BullX", url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}` },
      { text: "🐸 GMGN", url: `https://gmgn.ai/sol/token/${tokenMint}` },
    ],
    [
      { text: "🤖 Trojan", url: `https://t.me/solana_trojanbot?start=r-zooma-${tokenMint}` },
      { text: "🪐 Jupiter", url: `https://jup.ag/swap/SOL-${tokenMint}` },
      { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${tokenMint}` },
    ],
    [
      { text: "🔍 Solscan", url: `https://solscan.io/token/${tokenMint}` },
    ],
  ];
}
