/**
 * JEV integration — TypeSafe's System One model.
 *
 * IMPORTANT: this is advisory, not authoritative. The deterministic rule
 * in signalEngine.ts (N wallets bought in window) is what decides whether
 * a signal fires. JEV only adds a classification on top — "does this look
 * organic or coordinated?" — that gets surfaced in the alert as a labeled
 * model read, not used to suppress or force a signal. Two reasons:
 *   1. Jev launched days ago with no published track record on crypto/
 *      on-chain classification specifically — there's no basis yet to
 *      trust it enough to gate anything.
 *   2. Your brief is explicit that scores/signals must never be a black
 *      box. A rule with visible thresholds is auditable by construction;
 *      a model's classification, even a calibrated one, is not — so it
 *      supplements the evidence trail, it doesn't replace it.
 *
 * API contract (TypeSafe System One, confirmed from TypeSafe's own docs):
 *   POST https://api.typesafe.ai/v1/systemone
 *   { model: "jev-latest", state: <string|object>, questions: { name: {type, instructions, criteria} } }
 * Returns typed answers with calibrated probabilities/confidence — never
 * free text, so there's nothing here for it to hallucinate.
 */

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export interface AccumulationClassification {
  pattern: "organic" | "coordinated_or_wash" | "unclear";
  confidence: number;
  probabilities: Record<string, number>;
}

interface BuyEvent {
  wallet: string;
  solAmount: number;
  tokenAmount: number;
  timestamp: number;
}

export interface RiskClassification {
  level: "looks_organic" | "some_red_flags" | "multiple_red_flags" | "classic_rug_setup";
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * Generic risk read for a meme coin / new token candidate, used by the
 * research module. Same advisory-only contract as the accumulation
 * classifier above: never gates whether a candidate gets surfaced, only
 * adds a labeled model read to the alert.
 */
export async function classifyTokenRisk(input: {
  tokenMint: string;
  liquidityUsd: number;
  volume24hUsd: number;
  ageHours: number;
  topHolderPct: number | null;
  socialGalaxyScore: number | null;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  deployerOtherTokensFound: number | null;
  deployerLikelyAbandonedCount: number | null;
}): Promise<RiskClassification | null> {
  if (!TYPESAFE_API_KEY) return null;

  const state = {
    token_mint: input.tokenMint,
    liquidity_usd: Math.round(input.liquidityUsd),
    volume_24h_usd: Math.round(input.volume24hUsd),
    age_hours: Number(input.ageHours.toFixed(1)),
    top_holder_pct_of_supply: input.topHolderPct !== null ? Number(input.topHolderPct.toFixed(1)) : "unknown",
    social_galaxy_score: input.socialGalaxyScore ?? "unknown",
    mint_authority_renounced: input.mintAuthorityRenounced ?? "unknown",
    freeze_authority_renounced: input.freezeAuthorityRenounced ?? "unknown",
    deployer_other_tokens_found: input.deployerOtherTokensFound ?? "unknown",
    deployer_likely_abandoned_count: input.deployerLikelyAbandonedCount ?? "unknown",
  };

  const body = {
    model: TYPESAFE_MODEL,
    state,
    questions: {
      risk: {
        type: "score",
        instructions:
          "Given these market/on-chain metrics for a newly-surfaced token, rate how much its profile resembles " +
          "a high-risk or rug-pull setup versus a more organic launch. Very low liquidity relative to volume, " +
          "extreme holder concentration, and very young age are red flags. High social score with thin liquidity " +
          "is also a red flag (hype without depth). An un-renounced mint authority (deployer can print more supply) " +
          "or un-renounced freeze authority (deployer can freeze holder wallets) are strong red flags on their own. " +
          "A deployer with several other tokens that are now at near-zero liquidity is a strong red flag " +
          "(serial-rug pattern) — weight this heavily if deployer_likely_abandoned_count is 2 or more.",
        criteria: ["Looks organic", "Some red flags", "Multiple red flags", "Classic rug setup"],
      },
    },
  };

  try {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[jev] risk API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const json = await res.json();
    const answer = json?.answers?.risk;
    if (!answer || answer.type !== "score") return null;

    const levels: RiskClassification["level"][] = [
      "looks_organic",
      "some_red_flags",
      "multiple_red_flags",
      "classic_rug_setup",
    ];
    const roundedIndex = Math.max(0, Math.min(levels.length - 1, Math.round(answer.score)));

    return {
      level: levels[roundedIndex],
      confidence: answer.confidence,
      probabilities: answer.probabilities ?? {},
    };
  } catch (err) {
    console.error("[jev] risk classification failed:", (err as Error).message);
    return null;
  }
}

/**
 * Returns null (never throws) if JEV isn't configured or the call fails —
 * callers must treat "no read" as a normal, expected outcome, not an error
 * to surface to the user. A missing classification should never block a
 * signal or a notification.
 */
export async function classifyAccumulationPattern(input: {
  tokenMint: string;
  buys: BuyEvent[];
}): Promise<AccumulationClassification | null> {
  if (!TYPESAFE_API_KEY) return null;

  // Wallets are truncated for the model's state, not hidden — the full
  // address is still in signal_evidence and raw_events. This just keeps
  // the state small and avoids handing a third party full addresses
  // unnecessarily.
  const state = {
    token_mint: input.tokenMint,
    buy_events: input.buys.map((b) => ({
      wallet_short: `${b.wallet.slice(0, 6)}...${b.wallet.slice(-4)}`,
      sol_spent: Number(b.solAmount.toFixed(4)),
      token_amount: b.tokenAmount,
      unix_timestamp: b.timestamp,
    })),
  };

  const body = {
    model: TYPESAFE_MODEL,
    state,
    questions: {
      pattern: {
        type: "choice",
        instructions:
          "These are buy transactions for one token from several distinct wallets within a short window. " +
          "Does the pattern look like independent, organic accumulation, or does it look coordinated " +
          "(e.g. suspiciously uniform sizing or synchronized timing consistent with wash trading or one " +
          "actor operating multiple wallets)?",
        criteria: {
          organic: "Buy sizes and timing look independent and vary naturally between wallets",
          coordinated_or_wash: "Buy sizes and/or timing are suspiciously uniform or tightly synchronized",
          unclear: "Not enough distinguishing signal in this data either way",
        },
      },
    },
  };

  try {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[jev] API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    const answer = json?.answers?.pattern;
    if (!answer || answer.type !== "choice") return null;

    return {
      pattern: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities ?? {},
    };
  } catch (err) {
    console.error("[jev] classification failed:", (err as Error).message);
    return null;
  }
}
