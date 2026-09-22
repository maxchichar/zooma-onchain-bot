-- Migration 005: research signal scoring (meme coins, NFTs). Run in the
-- Supabase SQL editor.

create table if not exists research_signal_scores (
  id uuid primary key default gen_random_uuid(),
  category text not null,       -- 'meme_coin_watch' | 'nft_watch'
  jev_level text,                -- JEV risk level bucket, or null = 'no JEV read'
  trades_with_outcome int not null,
  win_rate numeric,
  avg_pnl_pct numeric,
  evidence jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists research_signal_scores_cat_time_idx
  on research_signal_scores (category, jev_level, computed_at desc);
