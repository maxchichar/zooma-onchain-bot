-- Migration 003: paper trading. Run in the Supabase SQL editor.
-- Safe on a fresh install too (only adds a new table, no conflicts).

create table if not exists paper_trades (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references signals(id) on delete set null,
  token_mint text not null, -- SPL token mint, or NFT collection symbol
  category text not null,   -- 'wallet_pattern' | 'meme_coin_watch' | 'nft_watch'
  quote_currency text not null, -- 'usd' (meme coins / wallet-pattern tokens) | 'sol' (NFTs)

  entry_price numeric not null,
  entry_time timestamptz not null default now(),
  position_size numeric not null, -- virtual notional, in quote_currency units

  stop_loss_price numeric,
  target_price numeric,
  max_hold_until timestamptz not null,

  status text not null default 'open', -- 'open' | 'closed'
  exit_price numeric,
  exit_time timestamptz,
  exit_reason text, -- 'stop_loss' | 'target' | 'time_exit' | 'price_unavailable'

  pnl_pct numeric,       -- return %, after modeled fees + slippage — the number that matters most
  pnl_absolute numeric,  -- in quote_currency units
  fees_absolute numeric,

  created_at timestamptz not null default now()
);

create index if not exists paper_trades_status_idx on paper_trades (status);
create index if not exists paper_trades_category_time_idx on paper_trades (category, entry_time desc);
