# Phase 1 (live, unattended): wallet accumulation signal bot

Runs without you. Watches a set of Solana wallets in near-real-time via
Helius webhooks, auto-expands the watch list, applies one deterministic
rule (ACCUMULATION: N+ tracked wallets buy the same token within a time
window), and drops evidence-backed `[UNVALIDATED]` alerts to Telegram.

**Read this before you trust anything it says:** every signal is tagged
`UNVALIDATED` on purpose. This bot detects a *pattern*, not a *proven
edge* — Phase 0/4 backtesting is what would tell you whether this pattern
has ever actually made money net of costs. Nothing here should be acted
on as if it's proven until that's done.

## What it does NOT do

- Does not execute trades. It only reads the chain and sends messages.
- Does not claim a signal is profitable — see the `UNVALIDATED` tag.
- Does not add wallets to the watch list without logging why in
  `discovery_log`, and it caps how many it adds per run.

## Architecture

```
Helius (watches tracked_wallets)
   │  webhook POST, ~1-5s latency, on every SWAP touching a tracked wallet
   ▼
Render free web service (server.ts)
   │  parses the tx, saves to raw_events, checks the ACCUMULATION rule
   ▼
Supabase (Postgres) — state: tracked_wallets, raw_events, signals, signal_evidence
   │
   ▼
Telegram — [UNVALIDATED] alert with evidence, only if not in cooldown

Separately, on a 30-min GitHub Actions cron (discover.ts):
tracked wallets' recent buys → token's current top holders (RPC, free)
   → filter out known programs / already-tracked → add up to 5/run
   → update the Helius webhook to include them
```

## One-time setup

### 1. Supabase (free Postgres)
1. Create a project at supabase.com (free tier).
2. Open the SQL editor, paste and run `schema.sql`.
3. Grab your Project URL and the **service_role** key (Settings → API) —
   not the `anon` key, since this runs server-side with no user auth.

### 2. Seed your tracked wallets
Insert your Phase 0 wallet list (or a fresh vetted list) directly in the
Supabase table editor, or via SQL:
```sql
insert into tracked_wallets (address, source) values
  ('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'seed'),
  ('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'seed');
```
Start with wallets you have some conviction in (e.g. ones that showed a
positive read in the Phase 0 script) — the discovery job only ever
expands *outward* from whatever you seed here, so a bad seed list means
bad discovery too.

### 3. Telegram bot
1. Message **@BotFather** on Telegram, `/newbot`, follow the prompts →
   you get a bot token.
2. Message your new bot once (anything), then visit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and find your
   `chat.id` in the response — that's your `TELEGRAM_CHAT_ID`.

### 4. Deploy the server to Render (free)
1. Push this folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables (Render dashboard → Environment): all of
   `.env.example`'s keys except `HELIUS_WEBHOOK_ID`/`WEBHOOK_URL` (you
   don't have those yet — see next step). Invent your own random string
   for `HELIUS_WEBHOOK_SECRET`.
5. Deploy. Note the public URL Render gives you, e.g.
   `https://your-app.onrender.com`.

### 5. Register the Helius webhook
Locally:
```
HELIUS_API_KEY=xxx HELIUS_WEBHOOK_SECRET=yyy \
WEBHOOK_URL=https://your-app.onrender.com/webhooks/helius \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
npm run register-webhook
```
It prints a `webhookID`. Save it as `HELIUS_WEBHOOK_ID` — both in your
local `.env` (for future `discover` runs) and in Render's environment
variables (not required by the server itself, but keep it alongside the
others for consistency) and as a GitHub Actions secret (step 7).

### 6. Keep the free Render instance awake
Render's free web services spin down after ~15 minutes with no inbound
HTTP traffic. Use a free external pinger to hit `/health` every ~10
minutes:
- **cron-job.org** (free, no signup limits) — create a job hitting
  `https://your-app.onrender.com/health` every 10 minutes.
- or **UptimeRobot** (free tier, 5-minute minimum interval).

**Be honest with yourself about this:** this is a workaround, not an
officially supported pattern — Render's own docs say so. It generally
works, but if it ever stops (Render tightens the policy, the external
pinger has an outage, whatever), webhooks arriving while the instance is
asleep on a cold-start delay could be missed or delayed. If reliability
starts to matter more than $0, Render's Starter tier ($7/mo) removes this
problem entirely by not sleeping at all.

### 7. Set up the discovery cron (GitHub Actions, free)
In your GitHub repo → Settings → Secrets and variables → Actions, add:
`HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET`, `HELIUS_WEBHOOK_ID`,
`WEBHOOK_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

The workflow in `.github/workflows/discover.yml` runs every 30 minutes
automatically once these secrets exist — nothing else to do.

## Running locally (for testing before deploying)
```
npm install
cp .env.example .env   # fill in real values
npm run dev             # starts the webhook server with auto-reload
```
To test the webhook receiver without waiting for a real transaction, POST
a sample Helius enhanced-transaction payload to
`http://localhost:3000/webhooks/helius` with an `Authorization` header
matching your `HELIUS_WEBHOOK_SECRET` (Helius's docs have sample payloads
under Enhanced Webhooks).

## JEV + LLM (optional, both fail gracefully if unset)

The pipeline is now: **rule fires → JEV classifies → LLM explains**, matching
the hybrid architecture from the original research doc — with one
deliberate constraint: **the rule is still what decides whether a signal
fires.** JEV and the LLM only add to the alert; neither can suppress or
force one. Reasons this is a hard line, not a preference:

- JEV (`jev-latest`) is days old with no published crypto-specific track
  record. There's no basis yet to trust it enough to gate a signal on.
- Letting a model's classification silently decide whether you get
  notified is exactly the black-box behavior your brief ruled out —
  a visible threshold you can point to is auditable, a model probability
  alone is not.

**What JEV does here (`src/jev.ts`):** once the accumulation rule matches,
JEV gets the (truncated, still-traceable) buy events for that window and
answers one typed `choice` question — does this look like organic
accumulation or something coordinated/wash-trading-shaped? That comes
back as `pattern` + `confidence`, gets stored in `signals.details`, and
shown in the Telegram message labeled explicitly as *"a model
classification, not proof."*

**What the LLM does here (`src/llm.ts`):** takes the rule's result plus
JEV's read — nothing else, no raw chain access — and writes 2-4 plain
sentences describing them. Its system prompt forbids inventing anything
not in that JSON and forbids any trading recommendation. If you want to
audit exactly what it can and can't do, that whole prompt is in the file.

**Both are optional.** Leave `TYPESAFE_API_KEY` / `GROQ_API_KEY` unset
in `.env` and the bot runs exactly as before — rule fires, plain templated
message, no classification line. Same if either API call fails at
runtime (rate limit, outage, bad key) — it logs the error and falls back
rather than dropping the notification.

**On the LLM provider:** the code uses Groq's API (`GROQ_MODEL=llama-3.3-70b-versatile`
by default — check console.groq.com/docs/models for the current catalog,
Groq's lineup changes more than most). It's OpenAI-compatible, so if you
want a different OpenAI-compatible provider later, only the `fetch` call
in `src/llm.ts` needs to change — the rest of the pipeline just expects a
string back.

## Scaling coverage ("maximize" mode)

Two knobs control discovery growth now, both in `.env`:

- `MAX_NEW_WALLETS_PER_RUN` — pacing per run. Raised to 25 by default (was
  5). Safe to raise further; it's just a rate, not a real ceiling.
- `MAX_TRACKED_WALLETS` — the real ceiling, defaulting to 5000. Read the
  comment above it in `.env.example` — it's sized against Helius's free
  1M-credits/month budget (1 credit per webhook event delivered), not
  picked arbitrarily. Raise it, but watch your Helius dashboard usage for
  a week after each increase rather than jumping straight to "unlimited."
  Once you hit this cap, discovery becomes a no-op (it logs and skips)
  rather than failing loudly — check the server logs or `discovery_log`
  if wallet growth suddenly stops.

Discovery scheduling moved from the GitHub Actions cron into the always-on
server itself (`DISCOVERY_INTERVAL_MINUTES`, default 5) — this sidesteps
GitHub's free-minute budget (2,000 min/month on a private repo) and its
scheduling delays entirely, since the server is already running
continuously. The GitHub Actions workflow now only runs on manual trigger
(`workflow_dispatch`), as a backup if you ever need to force a run from
CI.

**One thing scaling coverage does NOT do: create an edge.** More tracked
wallets means more `[UNVALIDATED]` alerts, not more validated ones — the
`ACCUMULATION_THRESHOLD` corroboration requirement and the `UNVALIDATED`
tag stay in place regardless of how many wallets you track, because
Phase 0/4 backtesting is still the only thing that can tell you whether
any of this predicts anything.

## Research module: meme coins and NFTs (separate from wallet tracking)

This runs alongside the wallet-based ACCUMULATION pipeline, on its own
schedule (`RESEARCH_INTERVAL_MINUTES`, default 15), using entirely
different data sources — no Helius credits involved.

**On "research X":** X's own API has had no free read tier since February
2026 (pay-per-use, ~$0.005/read minimum, no free allowance) — confirmed
against current pricing, not assumed. The old free workarounds are also
dead: Nitter (the open-source X frontend a lot of free tools relied on)
was shut down by a legal cease-and-desist in August 2026. Scraping X
directly isn't a reasonable substitute either — it requires login,
breaks constantly against anti-bot measures, and violates X's terms of
service. None of that is used here.

Instead:
- **Meme coin discovery**: DexScreener's free, no-key endpoints for
  recently boosted/newly-profiled tokens, cross-checked against the
  token's *actual* liquidity and 24h volume (`RESEARCH_MIN_LIQUIDITY_USD`,
  `RESEARCH_MIN_VOLUME_24H_USD`) — being boosted or having a fresh profile
  page means someone paid for attention, not that the token is liquid or
  real. Both filters must pass before a candidate surfaces at all.
- **Social signal**: LunarCrush's free tier (optional — set
  `LUNARCRUSH_API_KEY`), which aggregates activity *from* X, Reddit, and
  other platforms into a derived Galaxy Score rather than exposing raw
  posts. This is the X-adjacent signal, legitimately sourced. Skipped
  gracefully if you don't set a key.
- **NFT discovery**: Magic Eden's free public Solana API (no key, 120
  req/min), sampling collections and flagging ones whose cumulative
  volume jumped a lot (`NFT_VOLUME_SPIKE_PCT`) versus the last scan —
  stored in `nft_collection_snapshots` so each run has a real baseline
  to compare against, not just a snapshot of "what's currently big."

**Rug-risk check:** every meme coin candidate also gets a holder-
concentration check (reusing the same free Solana RPC call as wallet
discovery), plus two more checks specifically added for detailed
rug-risk detail (`src/rugRisk.ts`):
- **Mint & freeze authority status** — unambiguous, not a heuristic. If
  the deployer hasn't renounced the mint authority, they can create
  unlimited additional supply whenever they want. If they haven't
  renounced the freeze authority, they can freeze a specific holder's
  wallet, blocking that holder from ever selling. One free RPC call
  checks both, and either one being un-renounced is flagged with a ⚠ in
  the alert.
- **Deployer history** — approximate and labeled as such. Traces the
  wallet that likely deployed the token, then checks how many *other*
  tokens that wallet has launched and how many of those are now sitting
  at near-zero liquidity — the classic serial-rug pattern. This is a
  heuristic (a legitimate builder with one failed prior launch would
  also trip this at a low count), not a certainty.

Both checks also feed into JEV's risk classification as additional
inputs, so an un-renounced authority or a serial-rug deployer history
pushes the JEV read toward higher risk too, not just the raw evidence
line. Treat everything from this module as a starting point for your
own diligence, not a vetted opportunity — meme coins and NFTs are the
highest-scam-density corner of on-chain activity, more so than the
wallet-pattern side of this bot.

**JEV + LLM here too, same rules as the wallet pipeline:** JEV gives a
risk read (`looks_organic` → `classic_rug_setup`) based on the metrics,
labeled explicitly as a model classification. The LLM turns the metrics
+ JEV read into 2-4 plain sentences, forbidden from recommending any
action and forbidden from inventing anything not in the data. Both
optional, both fail gracefully.

**Database change required:** run `schema_migration_002_research.sql` in
the Supabase SQL editor (safe on a fresh install too — it only adds to
what `schema.sql` creates, doesn't conflict with it).

## Paper trading: the actual answer to "does this make money"

This is the module the rest of the bot has been building toward. Every
signal — wallet ACCUMULATION, meme coin watch, NFT watch — now opens a
simulated position automatically, the moment it fires. No real funds
move, ever. This is what finally turns `[UNVALIDATED]` alerts into an
actual track record you can look at.

**How a trade plays out:**
1. Opens at the current market price (same DexScreener/Magic Eden price
   sources the signal/research modules already use).
2. Gets a stop-loss (`PAPER_STOP_LOSS_PCT` below entry), a take-profit
   (`PAPER_TAKE_PROFIT_PCT` above entry), and a hard time limit
   (`PAPER_MAX_HOLD_HOURS`) — checked every `PAPER_CHECK_INTERVAL_MINUTES`.
   The time limit exists because meme coins especially can just sit
   there forever without hitting either threshold; without a bound,
   trades would never close and you'd never get an answer.
3. Closes on whichever condition hits first, with **fees and slippage
   modeled on both entry and exit** (`PAPER_FEE_PCT`, `PAPER_SLIPPAGE_PCT`)
   — ignoring these is the single most common way a paper-trading system
   lies to you about performance. Sends a Telegram notification either way.

**Reading the results:**
- `npm run report` any time for 7/30/90-day stats, or wait for the
  automatic Telegram digest every `PAPER_DIGEST_INTERVAL_HOURS`.
- The numbers: win rate, average PnL%, profit factor, max drawdown, and
  total PnL (reported separately in USD and SOL — these are never
  averaged together, since they're different trade types).
- **The verdict line is the point.** Below roughly 20 closed trades, take
  any "positive expectancy" reading as noise, not signal — the digest
  says so explicitly. If avg PnL% comes out non-positive with a
  reasonable sample size, it says `NO EDGE DETECTED`. That's a correct,
  useful answer — it's the whole reason this module exists, not a
  failure state to explain away.

**What this does NOT tell you:** whether you personally could have
captured these fills in real time. Paper trades execute at the price the
API reports at check time — real execution has additional latency,
real slippage can be worse under actual market impact, and sniping bots
on Solana often beat anything slower than sub-second. A positive paper
result is necessary but not sufficient before considering real money;
that's a separate, later conversation.

**Database change required:** run `schema_migration_003_paper_trading.sql`
in the Supabase SQL editor.

## Wallet credibility scoring

The piece from the original brief that hadn't been built until now: a
transparent 0-100 score per tracked wallet, with visible evidence for
why — not a black box, not a JEV/LLM guess. Every point in the score
traces to a specific number from your own paper-trading data.

**How it's computed** (full math and reasoning in the comment header of
`src/walletScoring.ts` — worth reading if you want to tune the weights):
a wallet's signals (via `signal_evidence`) are matched to their paper
trades. Win rate and average PnL% from those closed trades drive most of
the score, discounted when the sample is small (a wallet with 1 lucky
trade doesn't score like one with 20 consistent ones), plus a small
capped bonus for tenure and a capped penalty for any signal JEV flagged
as `coordinated_or_wash`. Every one of those inputs becomes a specific
evidence or warning line — nothing in the score isn't explained
somewhere in the output.

**Scope note:** this only covers wallet-pattern (ACCUMULATION) signals —
meme coin and NFT research signals aren't tied to one wallet's behavior,
so they're not part of this score.

**Output:**
- `npm run wallet-scores` — full report, every scored wallet, complete
  evidence/warnings, sorted best to worst.
- A Telegram digest every `WALLET_SCORE_INTERVAL_HOURS` (weekly by
  default — scoring depends on paper trades having closed, which takes
  time) with the top 5 and bottom 5.
- Every run is also stored in `wallet_scores` (append-only, so you can
  track how a wallet's score moves over time, not just its latest value).

**Database change required:** run `schema_migration_004_wallet_scores.sql`.

## Research signal scoring (meme coins / NFTs) — the equivalent for the side wallet scoring can't cover

Wallet scoring works because a wallet is a reusable entity you see again
and again. A meme coin or NFT collection isn't — each one is a one-off.
So instead of scoring the token, this scores **JEV's risk classification
itself**: is `looks_organic` actually outperforming `classic_rug_setup`
in your real paper-trading data, or not? That's the real equivalent
question — not "is this specific token trustworthy" but "is the thing
generating the risk read for this category trustworthy."

This is a calibration check, and it's built to report an uncomfortable
finding plainly rather than bury it: if `classic_rug_setup`-flagged
trades come out ahead of `looks_organic`-flagged ones, the digest says
so explicitly (⚠ line) rather than just listing numbers and hoping you
notice. That would mean JEV's risk read isn't earning its place in the
meme-coin/NFT alert yet — a real, useful thing to find out.

**Output:**
- `npm run research-scores` — every (category, JEV level) bucket, full
  evidence/warnings.
- A Telegram digest on the same schedule as wallet scoring
  (`WALLET_SCORE_INTERVAL_HOURS`), including the calibration-mismatch
  warning if one shows up.
- Stored in `research_signal_scores` (append-only history).

**Database change required:** run `schema_migration_005_research_scoring.sql`.

## Telegram slash commands (control the bot from the chat itself)

The bot isn't just one-way alerts anymore — you can message it directly:

- `/watch <wallet address>` — start tracking a wallet (updates the Helius webhook automatically)
- `/unwatch <wallet address>` — stop tracking one
- `/list` — how many wallets are tracked, plus the 5 most recently added
- `/status` — signals in the last 24h, open/closed paper trade counts
- `/scores` — top and bottom wallet credibility scores right now
- `/help` — show all commands

**Setup (one extra step beyond everything above):**
1. Add `TELEGRAM_WEBHOOK_SECRET` (any random string you invent) to Render's environment variables.
2. Locally: `TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WEBHOOK_URL=https://your-app.onrender.com/webhooks/telegram npm run register-telegram-webhook`.
3. Message your bot `/help` on Telegram to confirm it responds.

This runs through a second webhook endpoint on the same always-on server (`/webhooks/telegram`), separate from the Helius one — different sender, different auth (Telegram's own secret-token header). `/watch` and `/unwatch` do exactly what manually editing `tracked_wallets` would do — there's no shortcut here that skips the evidence/validation rules the rest of the bot follows.

## Tuning the rule
Everything is in `.env`:
- `ACCUMULATION_THRESHOLD` — how many distinct tracked wallets need to buy
  the same token in-window before it fires (default 3).
- `ACCUMULATION_WINDOW_MINUTES` — the trailing window (default 120).
- `SIGNAL_COOLDOWN_HOURS` — minimum gap before the same (token, signal
  type) can fire again (default 6) — this is your anti-spam control.

There's deliberately only one rule wired up (`ACCUMULATION`) so you can
watch it against real data for a while before adding `DISTRIBUTION` or
`WATCH` — adding all three at once before you've seen how noisy even one
rule is in practice would make it hard to tell what's actually useful.

## What to check periodically
- `signals` table: is `ACCUMULATION` firing at a sane rate, or constantly
  (threshold too low / window too wide) or never (too strict / not enough
  tracked wallets)?
- `discovery_log`: are auto-discovered wallets sensible-looking traders,
  or mostly noise (CEX wallets, LP addresses that slipped through the
  filter, one-off airdrop recipients)? If it's mostly noise, tighten
  `MIN_HOLDER_BALANCE_FRACTION` in `discover.ts` or lower
  `MAX_NEW_WALLETS_PER_RUN`, or stop auto-expansion and curate manually.
- Cost: Helius free tier is 1M credits/month, 1 credit per webhook event
  delivered. Watch your usage in the Helius dashboard — a fast-growing
  auto-discovered wallet list is the thing most likely to burn through
  this faster than expected.