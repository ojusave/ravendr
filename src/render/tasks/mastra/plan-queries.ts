import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { loadWorkflowConfig } from "../../../config.js";
import { createPostgresEventBus } from "../../event-bus.js";
import { Tier } from "../../../shared/events.js";
import { logger } from "../../../shared/logger.js";
import { plannerAgent, type AskShape } from "../../../mastra/agents.js";

const MAX_QUERIES = 40;

export interface PlannedQuery {
  query: string;
  tier: "lite" | "standard" | "deep";
  angle: string;
}

export interface PlanResult {
  queries: PlannedQuery[];
}

export const plan_queries = task(
  {
    name: "plan_queries",
    plan: "starter",
    timeoutSeconds: 60,
    retry: { maxRetries: 2, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function plan_queries(
    sessionId: string,
    topic: string,
    feedback?: string,
    shape: AskShape = "narrative"
  ): Promise<PlanResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "agent.planning",
        step: "decomposing_topic",
      });

      const agent = plannerAgent(config.ANTHROPIC_MODEL, shape);
      const prompt = feedback
        ? `Topic: "${topic}"\n\nThe previous attempt failed verification. Verifier feedback:\n${feedback}\n\nAdjust your plan — queries should target what was missed. JSON only.`
        : `Topic: "${topic}"\n\nPlan the queries now. JSON only.`;

      const result = await agent.generate(prompt);
      const text = (result as { text?: string }).text ?? "";
      const plan = parsePlan(text, topic);

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "plan.ready",
        queries: plan.queries,
      });

      return plan;
    } finally {
      await events.stop();
    }
  }
);

function parsePlan(text: string, topic: string): PlanResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = JSON.parse(raw) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) throw new Error("queries missing");
    const queries: PlannedQuery[] = [];
    for (const q of parsed.queries) {
      const item = q as { query?: unknown; tier?: unknown; angle?: unknown };
      const query = String(item.query ?? "").trim();
      const tier = Tier.safeParse(item.tier).success
        ? (item.tier as PlannedQuery["tier"])
        : "standard";
      const angle = String(item.angle ?? "").trim() || "overview";
      if (query.length >= 4) queries.push({ query, tier, angle });
    }
    if (queries.length < 1) throw new Error("no valid queries");
    return { queries: queries.slice(0, MAX_QUERIES) };
  } catch (err) {
    logger.warn(
      { err, text: text.slice(0, 200) },
      "plan parse failed — using fallback"
    );
    return {
      queries: [
        { query: `Comprehensive overview of: ${topic}`, tier: "standard", angle: "overview" },
        { query: `Recent developments: ${topic} (last 12 months)`, tier: "lite", angle: "recent events" },
        { query: `Key people, groups, and milestones for: ${topic}`, tier: "lite", angle: "key actors" },
      ],
    };
  }
}
