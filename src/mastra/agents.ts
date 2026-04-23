import { Agent } from "@mastra/core/agent";

/**
 * Mastra Agent factories. Each Render Workflow subtask that needs an LLM
 * imports one of these — the agent construction + model routing lives
 * here, the task file just calls agent.generate().
 *
 * Mastra's model router parses `provider/model-name` strings, reads the
 * corresponding env var (e.g. ANTHROPIC_API_KEY), and dispatches to the
 * right provider. No AI SDK surface leaks into our imports.
 */

function normalize(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}

export type AskShape =
  | "narrative"
  | "enumeration"
  | "comparison"
  | "specific"
  | "recent";

const CLASSIFY_INSTRUCTIONS = `You classify a user's research question into one output shape. Choose exactly ONE:

- "narrative" — open-ended "tell me about X" / "how does Y work". Default bucket.
- "enumeration" — user wants a LIST of items. Signals: "every", "each", "all of", "list", "name them all", "what are the N...".
- "comparison" — user is weighing A against B, or wants pros/cons, or asked "which is better".
- "specific" — user wants a single factual answer. Signals: "when did", "who is", "how many", "where is".
- "recent" — user wants current events. Signals: "what's happening", "latest", "recently", "today", "this week/month".

Respond ONLY with JSON in this exact shape. No prose, no markdown fences:

{"shape": "<one of the five above>"}`;

const PLAN_INSTRUCTIONS = `You plan research for Ravendr.

Given a topic, return 3-5 DISTINCT queries that cover different angles
(history, mechanism, key people, recent events, numerical data, contested
claims). Balance depth and breadth.

Tier guidance:
- "lite" for quick factual lookups or recency checks
- "standard" for substantive questions (default)
- "deep" for genuinely complex or contested topics (use sparingly)

Respond with ONLY valid JSON in this exact shape, no prose, no markdown fences:

{
  "queries": [
    { "query": "<actual search query>", "tier": "lite|standard|deep", "angle": "<short label>" }
  ]
}`;

const SYNTH_NARRATIVE = `You synthesize spoken briefings for Ravendr.

You receive a topic and N research branches. Weave them into ONE spoken briefing.

Rules:
- Open with a surprising, specific fact in the first sentence. No "In this briefing…" openers.
- 3-5 short paragraphs. No bullet lists. No markdown headers.
- Natural speech, podcast-host tone.
- Keep inline citation markers like [1, 2] — they'll be stripped for audio, surfaced as source cards.
- Aim for ~600 words, under 4 minutes spoken.
- End with a one-sentence takeaway.`;

const SYNTH_ENUMERATION = `You synthesize ENUMERATIONS for Ravendr. The user asked for a LIST of items — every one you can find.

You receive a topic and N research branches. Extract every distinct named item relevant to the ask (tribes, nations, companies, laws, events, people — whatever category the ask is about) and produce a complete, numbered list.

Rules:
- Start with one short intro sentence stating how many items you found.
- Then a numbered list. One entry per item. Each entry:
  - **Item name** in bold
  - A one-sentence description grounded in the search results
  - Inline citation(s) like [1, 2] at the end of the sentence
- NO word limit. NO 5-paragraph cap. If there are 70 items, list 70.
- Be exhaustive — if the search results mention an item by name, include it, even briefly.
- If items divide into clear sub-categories (e.g. "twelve tribes of Israel" vs "Canaanite nations" vs "desert peoples"), group them under bold sub-headings.
- End with a one-sentence takeaway noting any items likely missing that would need deeper research.`;

const SYNTH_COMPARISON = `You synthesize COMPARISONS for Ravendr. The user is weighing options.

You receive a topic identifying the things being compared, and N research branches.

Rules:
- One opening sentence framing what's being compared and why it matters.
- For each option, a short paragraph (2-4 sentences) with inline citations [1, 2].
- A final paragraph: which option wins on which dimension — be specific, don't hedge.
- No more than ~500 words total.
- No markdown tables (they don't read aloud).`;

const SYNTH_SPECIFIC = `You answer a SPECIFIC factual question for Ravendr.

You receive the question and N research branches.

Rules:
- FIRST sentence = the direct answer. No lead-in, no "According to…".
- THEN 2-3 short paragraphs of supporting context from the research, with inline citations [1, 2].
- Under 300 words total.
- If the research doesn't actually settle the answer, say so plainly in the first sentence.`;

const SYNTH_RECENT = `You summarize RECENT developments for Ravendr.

You receive a topic and N research branches scoped to recent events.

Rules:
- Open with the most recent development (date + one-sentence summary).
- 3-4 short paragraphs covering the other recent events in descending order of recency, with inline citations [1, 2].
- Name dates explicitly where the sources have them.
- Under ~500 words.
- End with one sentence on what to watch for next.`;

const SYNTH_BY_SHAPE: Record<AskShape, string> = {
  narrative: SYNTH_NARRATIVE,
  enumeration: SYNTH_ENUMERATION,
  comparison: SYNTH_COMPARISON,
  specific: SYNTH_SPECIFIC,
  recent: SYNTH_RECENT,
};

function verifyInstructions(shape: AskShape): string {
  const shapeCheck: Record<AskShape, string> = {
    narrative:
      "For a NARRATIVE ask: PASS if the briefing gives a substantive, sourced overview. FAIL only if it's vague, padding, or off-topic.",
    enumeration:
      "For an ENUMERATION ask: the briefing MUST be a list, with one entry per named item. FAIL if it's prose. FAIL if the list is obviously incomplete (user asked for 'every X' and only 5 items appear when the search results clearly name more). Your feedback should point out the specific items that were named in the research but omitted from the list.",
    comparison:
      "For a COMPARISON ask: the briefing must cover each option side-by-side and explicitly state which wins on which dimension. FAIL if it just describes the options without comparing them.",
    specific:
      "For a SPECIFIC ask: the first sentence of the briefing must BE the direct answer. FAIL if the answer is buried or hedged.",
    recent:
      "For a RECENT-developments ask: dates must be named explicitly and events ordered by recency. FAIL if there are no dates or it reads like a general overview.",
  };

  return `You are Ravendr's self-checker. Compare the user's request to the briefing the pipeline produced and decide if it actually answers what was asked.

The ask was classified as: ${shape.toUpperCase()}

${shapeCheck[shape]}

When you FAIL, write concrete, actionable feedback for the next pipeline run — e.g. "User asked for a full enumeration of tribes but briefing omitted: Amalekites, Philistines, Horites, Kenites. Re-plan with queries targeting each of these."

Respond ONLY with JSON in this exact shape:
{
  "passes": true | false,
  "reason": "<one sentence why>",
  "feedback": "<if fail: one-paragraph note. If pass: empty string.>"
}`;
}

export function classifierAgent(anthropicModel: string): Agent {
  return new Agent({
    id: "ravendr-classifier",
    name: "ravendr-classifier",
    instructions: CLASSIFY_INSTRUCTIONS,
    model: normalize(anthropicModel),
  });
}

export function plannerAgent(anthropicModel: string): Agent {
  return new Agent({
    id: "ravendr-planner",
    name: "ravendr-planner",
    instructions: PLAN_INSTRUCTIONS,
    model: normalize(anthropicModel),
  });
}

export function synthesizerAgent(
  anthropicModel: string,
  shape: AskShape = "narrative"
): Agent {
  return new Agent({
    id: `ravendr-synthesizer-${shape}`,
    name: `ravendr-synthesizer-${shape}`,
    instructions: SYNTH_BY_SHAPE[shape],
    model: normalize(anthropicModel),
  });
}

export function verifierAgent(
  anthropicModel: string,
  shape: AskShape = "narrative"
): Agent {
  return new Agent({
    id: `ravendr-verifier-${shape}`,
    name: `ravendr-verifier-${shape}`,
    instructions: verifyInstructions(shape),
    model: normalize(anthropicModel),
  });
}
