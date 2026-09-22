-- Migration 004: wallet credibility scoring. Run in the Supabase SQL editor.

create table if not exists wallet_scores (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  score numeric not null, -- 0-100, see walletScoring.ts for the exact formula
  signal_count int not null,
  trades_with_outcome int not null,
  win_rate numeric,
  avg_pnl_pct numeric,
  coordinated_flag_count int not null default 0,
  tenure_days numeric,
  source text, -- 'seed' | 'auto_discovered', from tracked_wallets at compute time
  evidence jsonb not null default '[]'::jsonb,  -- array of positive-evidence strings
  warnings jsonb not null default '[]'::jsonb,  -- array of warning strings
  computed_at timestamptz not null default now()
);

create index if not exists wallet_scores_wallet_time_idx on wallet_scores (wallet, computed_at desc);
