-- Migration 006: Top trader entry tracking. Run in the Supabase SQL editor.
-- Records smart money wallets, top holders, and early buyers with their exact entry price, amounts, and transaction signatures.

create table if not exists top_trader_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  token_mint text not null,
  token_symbol text,
  entry_price_usd numeric,
  sol_amount numeric,
  token_amount numeric,
  tx_signature text,
  entry_time timestamptz not null default now(),
  trader_category text not null default 'smart_money', -- 'smart_money' | 'top_holder' | 'early_buyer' | 'whale'
  source text not null default 'onchain_tx',           -- 'onchain_tx' | 'discovery' | 'scan'
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists top_trader_wallet_idx on top_trader_entries (wallet_address);
create index if not exists top_trader_token_idx on top_trader_entries (token_mint);
create index if not exists top_trader_entry_time_idx on top_trader_entries (entry_time desc);
