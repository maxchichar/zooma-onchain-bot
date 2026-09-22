-- Migration 002: research module support (meme coins, NFTs).
-- Apply this in the Supabase SQL editor against your EXISTING database —
-- schema.sql alone is now out of date for a fresh install too, see below.

alter table signals
  add column if not exists category text not null default 'wallet_pattern';
  -- 'wallet_pattern' (the original ACCUMULATION signals) | 'meme_coin_watch' | 'nft_watch'

alter table signal_evidence
  alter column wallet drop not null,
  add column if not exists source text not null default 'onchain_tx',
  -- 'onchain_tx' | 'dexscreener' | 'lunarcrush' | 'magiceden' | 'solana_rpc'
  add column if not exists reference text;
  -- For non-tx evidence: a DexScreener pair URL, a Magic Eden collection
  -- symbol, a token mint. `signature`/`wallet` stay populated for
  -- onchain_tx rows exactly as before — nothing about the wallet-pattern
  -- path changes.

create table if not exists nft_collection_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  volume_all numeric,
  floor_price numeric,
  captured_at timestamptz not null default now()
);

create index if not exists nft_collection_snapshots_symbol_time_idx
  on nft_collection_snapshots (symbol, captured_at desc);

-- If you are setting this up FRESH (never ran schema.sql before), just
-- run schema.sql followed by this file — no conflict, this only adds to
-- what schema.sql already creates.
