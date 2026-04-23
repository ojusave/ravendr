import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { logger } from "../../shared/logger.js";
import { classifierAgent, type AskShape } from "../../mastra/agents.js";

const shapeSchema = z.enum([
  "narrative",
  "enumeration",
  "comparison",
  "specific",
  "recent",
]);

/**
 * Classifies the user's ask into an output shape so the downstream
 * synthesizer + verifier can adapt their prompts.
 *
 * Cheap LLM call — <1s. Runs before plan_queries in the research pipeline.
 */
export const classify_ask = task(
  {
    name: "classify_ask",
    plan: "starter",
    timeoutSeconds: 30,
    retry: { maxRetries: 2, waitDurationMs: 500, backoffScaling: 1.5 },
  },
  async function classify_ask(
    sessionId: string,
    topic: string
  ): Promise<{ shape: AskShape }> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      const agent = classifierAgent(config.ANTHROPIC_MODEL);
      const result = await agent.generate(`User ask: "${topic}"\n\nClassify. JSON only.`);
      const text = (result as { text?: string }).text ?? "";
      const shape = parseShape(text);

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "ask.classified",
        shape,
      });

      return { shape };
    } finally {
      await events.stop();
    }
  }
);

function parseShape(text: string): AskShape {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = JSON.parse(raw) as { shape?: unknown };
    const result = shapeSchema.safeParse(parsed.shape);
    if (result.success) return result.data;
    throw new Error("shape not in enum");
  } catch (err) {
    logger.warn(
      { err, raw: text.slice(0, 200) },
      "classify_ask: unparseable, defaulting to narrative"
    );
    return "narrative";
  }
}
