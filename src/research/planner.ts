import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Tier } from "../shared/events.js";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

const TierSchema: z.ZodType<Tier> = z.enum(["lite", "standard", "deep"]);

export const planSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(4),
        tier: TierSchema,
        angle: z.string().min(2),
      })
    )
    .min(3)
    .max(5),
});
export type Plan = z.infer<typeof planSchema>;

const SYSTEM = `You plan research for Ravendr.

Given a user's spoken topic, return 3–5 distinct queries that cover different
angles (e.g., history, mechanism, recent events, contested claims, key
people, numerical data).

Rules:
- 3 queries for narrow/factual topics, up to 5 for broad/contested topics.
- "standard" tier for substance; "lite" for quick factual lookups or recency.
- angle is a short human-readable label ("history", "mechanism", "recent events").
- Respond with ONLY valid JSON matching this shape, no prose, no markdown fences:

{
  "queries": [
    { "query": "...", "tier": "standard"|"lite", "angle": "..." }
  ]
}`;

export interface PlannerConfig {
  apiKey: string;
  model: string;
}

export async function planResearch(
  topic: string,
  config: PlannerConfig,
  signal?: AbortSignal
): Promise<Plan> {
  const client = new Anthropic({ apiKey: config.apiKey });
  try {
    const response = await client.messages.create(
      {
        model: config.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Topic: "${topic}"\n\nPlan 3–5 research queries. Respond with JSON only.`,
          },
        ],
      },
      { signal }
    );
    const first = response.content[0];
    const text = first && first.type === "text" ? first.text : "";
    const json = extractJson(text);
    const parsed = planSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues, text: text.slice(0, 200) },
        "planner output failed schema — using fallback"
      );
      return fallbackPlan(topic);
    }
    return parsed.data;
  } catch (err) {
    logger.error({ err }, "planner failed");
    throw new AppError("UPSTREAM_LLM", "planner LLM call failed", { cause: err });
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** If the LLM returns unparseable output, still produce something useful. */
function fallbackPlan(topic: string): Plan {
  return {
    queries: [
      { query: `Comprehensive overview of: ${topic}`, tier: "standard", angle: "overview" },
      { query: `Recent developments: ${topic} (last 12 months)`, tier: "lite", angle: "recent events" },
      { query: `Key people, groups, and milestones for: ${topic}`, tier: "lite", angle: "key actors" },
    ],
  };
}
