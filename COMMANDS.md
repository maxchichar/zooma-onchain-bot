# Commands — Onchain Intelligence Bot (phase1-live-bot)

Run from inside this folder (`phase1-live-bot/`).

## One-time setup
```
npm install
cp .env.example .env      # fill in Helius, Supabase, Telegram keys at minimum
```
Then in the Supabase SQL editor, run in this exact order:
```
schema.sql
schema_migration_002_research.sql
schema_migration_003_paper_trading.sql
schema_migration_004_wallet_scores.sql
schema_migration_005_research_scoring.sql
```
Seed at least one wallet into the `tracked_wallets` table before starting
the server (SQL editor or table view — see README.md).

## Local testing
```
npm run dev
```
Auto-reloads on file changes. Good for testing before deploying.

## Deploy
Push this folder to a GitHub repo, deploy to Render (build: `npm install`,
start: `npm start`), add every env var from `.env.example` to Render's
dashboard. Full walkthrough in README.md.

## One-time registration (after deploying, or whenever the wallet list / URL changes)
```
npm run register-webhook            # tells Helius which wallets to watch
npm run register-telegram-webhook   # enables /watch, /status, etc. in Telegram
```

## On-demand reports (run anytime, locally or via a shell on the server)
```
npm run report                      # paper trading stats: 7/30/90 days
npm run report -- 30                # custom window
npm run report -- 30 nft_watch      # filter by category
npm run wallet-scores                # full wallet credibility report
npm run research-scores              # JEV risk-calibration report (meme coins/NFTs)
npm run discover                     # manual one-off wallet discovery pass
```

## In Telegram, once deployed
```
/help       — show all commands
/watch      <address>  — start tracking a wallet
/unwatch    <address>  — stop tracking a wallet
/list       — show tracked wallet count + recent additions
/status     — recent signals + paper trade counts
/scores     — top/bottom wallet credibility right now
```

Everything else (tuning thresholds, cost limits, etc.) is environment
variables in `.env.example`, each documented inline. Full detail on every
module in README.md.
