-- Run this once in the Supabase SQL editor for your project (free tier).
-- Keeps state so the bot can run unattended: which wallets it watches,
-- every parsed swap it has seen (deduped by signature), which signals
-- have fired, and a log of what auto-discovery did and why.

create table if not exists tracked_wallets (
  address text primary key,
  added_at timestamptz not null default now(),
  -- 'seed' = you put it in manually / from Phase 0. 'auto_discovered' = the
  -- discovery job added it. Keep this distinction — auto-discovered wallets
  -- have not been vetted and should be treated with more suspicion.
  source text not null default 'seed',
  discovered_from_wallet text,
  discovered_from_token text
);

-- One row per (wallet, transaction) the webhook has parsed into a clean
-- buy/sell leg. signature+wallet is the dedupe key: Helius retries failed
-- deliveries, and a single transaction can touch more than one tracked
-- wallet.
create table if not exists raw_events (
  signature text not null,
  wallet text not null references tracked_wallets(address) on delete cascade,
  token_mint text not null,
  side text not null check (side in ('buy', 'sell')),
  token_amount numeric not null,
  sol_amount numeric not null,
  block_time timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (signature, wallet)
);

create index if not exists raw_events_token_time_idx
  on raw_events (token_mint, block_time desc);

-- Every signal this bot has ever fired. status starts at 'UNVALIDATED' and
-- MUST stay there until your Phase 4 backtesting framework has actually
-- confirmed this signal type has positive expectancy net of costs — do not
-- flip this manually just because a few calls looked good.
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  token_mint text not null,
  signal_type text not null, -- ACCUMULATION | DISTRIBUTION | WATCH
  status text not null default 'UNVALIDATED',
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create index if not exists signals_token_type_time_idx
  on signals (token_mint, signal_type, created_at desc);

-- Every signal must trace to specific transactions — this table IS the
-- evidence trail. Never let a signal exist without at least one row here.
create table if not exists signal_evidence (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references signals(id) on delete cascade,
  signature text not null,
  wallet text not null,
  note text
);

-- What the discovery job did on each run, so you can audit whether
-- auto-expansion is adding real signal or just noise.
create table if not exists discovery_log (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  candidate_address text not null,
  discovered_from_wallet text,
  discovered_from_token text,
  added boolean not null,
  reason text
);
