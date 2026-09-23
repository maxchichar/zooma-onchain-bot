/**
 * LLM integration: natural-language explanation ONLY.
 *
 * Structurally anti-hallucination:
 * Receives a strictly structured JSON object of already-computed on-chain facts
 * and synthesizes 2-3 concise sentences describing ONLY those facts.
 *
 * Uses Groq API with LLaMA 3.3 70B Versatile for sub-second streaming/generation.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
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
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[llm] Groq API notice ${res.status}`);
      return null;
    }

    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.warn("[llm] Groq call notice:", (err as Error).message);
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
- This signal is UNVALIDATED (no backtesting has confirmed it means anything yet): say so plainly, do not soften or omit it.
- Never recommend buying, selling, or any trading action. You are describing a detected rule match, not giving financial or investment advice.
- If a JEV classification is included, describe it as a model's read, not a fact: it can be wrong.
- 2-3 sentences. Plain text, no markdown headers, no bullet points.`;

export interface ResearchExplanationContext {
  category: "meme_coin_watch" | "nft_watch";
  tokenOrCollection: string;
  metrics: Record<string, unknown>;
  jevRead: { level: string; confidence: number } | null;
}

const RESEARCH_SYSTEM_PROMPT = `You write short alert explanations for a crypto research bot that surfaces meme coins and NFT collections getting unusual market/social attention.

Rules you must follow exactly:
- Use ONLY the facts given to you in the user message. Never invent metrics, prices, social activity, or history not present in the provided JSON.
- This is UNVALIDATED, high-risk-category research (meme coins and NFTs specifically): say so plainly.
- Never recommend buying, selling, minting, or any trading/collecting action. Describe what the data shows, not what to do about it.
- If a JEV risk read is included, describe it as a model's read, not a fact.
- 2-3 sentences. Plain text, no markdown headers, no bullet points.`;

export interface PumpExplanationContext {
  tokenMint: string;
  name: string;
  symbol: string;
  devHoldingPct: number;
  solAmount: number;
  marketCapSol: number;
  isGraduation?: boolean;
  jevPattern?: string;
  jevConfidence?: number;
}

const PUMP_SYSTEM_PROMPT = `You write ultra-crisp 2-sentence AI intelligence briefings for Solana Pump.fun token drops and Raydium graduations.

Rules you must follow strictly:
- Use ONLY the provided launch metrics (dev holding percentage, dev initial buy in SOL, market cap in SOL, graduation status).
- Synthesize what the creator commitment and valuation imply about early velocity or dump risk.
- Do NOT provide financial advice or encourage trading.
- Plain text only. No bullet points, no markdown headers.`;

export interface RugRiskExplanationContext {
  tokenMint: string;
  tokenName?: string;
  tokenSymbol?: string;
  securityScore: number;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  isToken2022: boolean;
  transferFeePct: number;
  hasPermanentDelegate: boolean;
  isDefaultFrozen: boolean;
  top1HolderPct: number | null;
  top10HolderPct: number | null;
  deployerAbandonedCount: number | null;
  flags: string[];
  jevRead?: { level: string; confidence: number } | null;
}

const RUG_SYSTEM_PROMPT = `You write professional 2-3 sentence smart contract security audits for Solana tokens.

Rules you must follow strictly:
- Analyze the exact technical audit facts: mint authority (can dev print supply?), freeze authority (can dev freeze wallets?), Token-2022 extensions (transfer fee/tax or permanent delegate seizure), top holder concentration, and deployer history.
- Plainly explain why the contract is safe or describe the specific mechanism that threatens holder funds.
- Do NOT give financial advice. Keep it technical, factual, and direct.
- Plain text only. No markdown headers, no bullet points.`;

export async function explainSignal(context: SignalExplanationContext): Promise<string | null> {
  const userContent = `Describe this detected pattern using only the facts below:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(SYSTEM_PROMPT, userContent);
}

export async function explainResearchCandidate(context: ResearchExplanationContext): Promise<string | null> {
  const userContent = `Describe this using only the facts below:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(RESEARCH_SYSTEM_PROMPT, userContent);
}

/**
 * Generates natural language AI analysis of a Pump.fun launch or graduation.
 */
export async function explainPumpDrop(context: PumpExplanationContext): Promise<string | null> {
  const userContent = `Analyze this Pump.fun token launch using only the facts below:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(PUMP_SYSTEM_PROMPT, userContent);
}

/**
 * Generates natural language AI security audit of a token's rug pull risk.
 */
export async function explainRugRisk(context: RugRiskExplanationContext): Promise<string | null> {
  const userContent = `Analyze this token's contract security using only the facts below:\n\n${JSON.stringify(context, null, 2)}`;
  return callGroq(RUG_SYSTEM_PROMPT, userContent);
}