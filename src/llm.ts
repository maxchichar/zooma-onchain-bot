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
 * Uses Groq's API (OpenAI-compatible chat completions format, fast +
 * cheap — a good fit for a short, low-stakes explanation task like this).
 * If you switch providers again later, only the fetch call in
 * callGroq() below needs to change — the rest of the pipeline just
 * expects a string back.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Check console.groq.com/docs/models for the current catalog — Groq
// adds/retires models more often than most providers. This default is a
// solid general-purpose choice as of when this was written, not a
// guarantee it'll still be current.
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(systemPrompt: string, userContent: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[llm] Groq API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("[llm] Groq call failed:", (err as Error).message);
    return null;
  }
}

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
 * Returns null (never throws) if the LLM isn't configured or the call
 * fails — the caller falls back to a plain templated message. A missing
 * explanation should never block a notification from being sent.
 */
export async function explainSignal(context: SignalExplanationContext): Promise<string | null> {
  const userContent = `Describe this detected pattern using only the facts below. Do not add anything not present here:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(SYSTEM_PROMPT, userContent);
}

/**
 * Same contract as explainSignal: returns null on failure/missing key,
 * never throws, never given anything it could invent details from.
 */
export async function explainResearchCandidate(context: ResearchExplanationContext): Promise<string | null> {
  const userContent = `Describe this using only the facts below. Do not add anything not present here:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(RESEARCH_SYSTEM_PROMPT, userContent);
}