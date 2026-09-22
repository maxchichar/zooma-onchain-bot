/**
 * LLM integration — natural-language explanation ONLY.
 *
 * Structurally anti-hallucination, matching your brief's requirement:
 * this function is never given raw chain access and is never asked to
 * decide anything (no score, no signal, no classification comes from
 * here — those are computed deterministically or by JEV before this is
 * ever called). It receives a small JSON object of already-computed facts
 * and is instructed to describe ONLY those facts. There is nothing in its
 * input for it to embellish into a false claim about wallet behavior.
 *
 * Defaults to the Anthropic Messages API. If you're using a different
 * provider, swap the fetch call below — the rest of the pipeline doesn't
 * care which LLM answers as long as this function returns a string.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

export interface SignalExplanationContext {
  tokenMint: string;
  signalType: string;
  walletCount: number;
  windowMinutes: number;
  jevRead: { pattern: string; confidence: number } | null;
  evidenceCount: number;
}

const SYSTEM_PROMPT = `You write short alert explanations for an on-chain trading-signal bot aimed at the bot's own operator.

Rules you must follow exactly:
- Use ONLY the facts given to you in the user message. Never invent wallet behavior, amounts, token names, prices, or history that isn't in the provided JSON.
- This signal is UNVALIDATED (no backtesting has confirmed it means anything yet) — say so plainly, don't soften or omit it.
- Never recommend buying, selling, or any trading action. You are describing a detected rule match, not giving financial or investment advice.
- If a JEV classification is included, describe it as a model's read, not a fact — it can be wrong.
- 2-4 sentences. Plain text, no markdown, no headers, no bullet points.`;

export interface ResearchExplanationContext {
  category: "meme_coin_watch" | "nft_watch";
  tokenOrCollection: string;
  metrics: Record<string, unknown>;
  jevRead: { level: string; confidence: number } | null;
}

const RESEARCH_SYSTEM_PROMPT = `You write short alert explanations for a crypto research bot that surfaces meme coins and NFT collections getting unusual market/social attention.

Rules you must follow exactly:
- Use ONLY the facts given to you in the user message. Never invent metrics, prices, social activity, or history not present in the provided JSON.
- This is UNVALIDATED, high-risk-category research (meme coins and NFTs specifically) — say so plainly.
- Never recommend buying, selling, minting, or any trading/collecting action. Describe what the data shows, not what to do about it.
- If a JEV risk read is included, describe it as a model's read, not a fact.
- 2-4 sentences. Plain text, no markdown, no headers, no bullet points.`;

/**
 * Same contract as explainSignal: returns null on failure/missing key,
 * never throws, never given anything it could invent details from.
 */
export async function explainResearchCandidate(context: ResearchExplanationContext): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: RESEARCH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Describe this using only the facts below. Do not add anything not present here:\n\n${JSON.stringify(
              context,
              null,
              2
            )}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[llm] research API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    const textBlock = (json?.content ?? []).find((c: { type: string }) => c.type === "text");
    return textBlock?.text ?? null;
  } catch (err) {
    console.error("[llm] research explanation failed:", (err as Error).message);
    return null;
  }
}

/**
 * Returns null (never throws) if the LLM isn't configured or the call
 * fails — the caller falls back to a plain templated message. A missing
 * explanation should never block a notification from being sent.
 */
export async function explainSignal(context: SignalExplanationContext): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Describe this detected pattern using only the facts below. Do not add anything not present here:\n\n${JSON.stringify(
              context,
              null,
              2
            )}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[llm] API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    const textBlock = (json?.content ?? []).find((c: { type: string }) => c.type === "text");
    return textBlock?.text ?? null;
  } catch (err) {
    console.error("[llm] explanation failed:", (err as Error).message);
    return null;
  }
}
