-- Migration 007: Pattern Learning & Profit Maximization Knowledge Base
-- Stores learned on-chain trading patterns, win rates, profit factors, and dynamic position multipliers.

create table if not exists learned_patterns (
  pattern_key text primary key,
  channel text not null default 'general_dex',
  liquidity_tier text not null default 'small',
  velocity_tier text not null default 'moderate',
  buy_ratio_tier text not null default 'neutral',
  dev_stake_tier text not null default 'low',
  sample_count integer not null default 0,
  win_count integer not null default 0,
  loss_count integer not null default 0,
  win_rate numeric not null default 0.50,
  avg_roi_pct numeric not null default 0.0,
  profit_factor numeric not null default 1.0,
  best_multiplier numeric not null default 1.0,
  tier text not null default 'B_TIER',
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists learned_patterns_channel_idx on learned_patterns (channel);
create index if not exists learned_patterns_tier_idx on learned_patterns (tier);
create index if not exists learned_patterns_win_rate_idx on learned_patterns (win_rate desc);
