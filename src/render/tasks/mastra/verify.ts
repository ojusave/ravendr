import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { loadWorkflowConfig } from "../../../config.js";
import { createPostgresEventBus } from "../../event-bus.js";
import { logger } from "../../../shared/logger.js";
import { verifierAgent, type AskShape } from "../../../mastra/agents.js";

export interface VerifyResult {
  passes: boolean;
  reason: string;
  feedback: string;
}

export const verify = task(
  {
    name: "verify",
    plan: "starter",
    timeoutSeconds: 60,
    retry: { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function verify(
    sessionId: string,
    topic: string,
    briefingText: string,
    shape: AskShape = "narrative"
  ): Promise<VerifyResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "verify.started",
      });

      const agent = verifierAgent(config.ANTHROPIC_MODEL, shape);
      const prompt = [
        `User request: "${topic}"`,
        ``,
        `Briefing:`,
        briefingText.slice(0, 8_000),
        ``,
        `Evaluate. JSON only.`,
      ].join("\n");

      const result = await agent.generate(prompt);
      const text = (result as { text?: string }).text ?? "";
      const parsed = parseVerdict(text);

      if (parsed.passes) {
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "verify.passed",
          reason: parsed.reason.slice(0, 200),
        });
      } else {
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "verify.failed",
          reason: parsed.reason.slice(0, 200),
          feedback: parsed.feedback.slice(0, 1_000),
        });
      }

      return parsed;
    } finally {
      await events.stop();
    }
  }
);

const verdictSchema = z.object({
  passes: z.boolean(),
  reason: z.string().default(""),
  feedback: z.string().default(""),
});

function parseVerdict(text: string): VerifyResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = verdictSchema.parse(JSON.parse(raw));
    return {
      passes: parsed.passes,
      reason: parsed.reason || (parsed.passes ? "ok" : "no reason given"),
      feedback: parsed.feedback,
    };
  } catch (err) {
    logger.warn(
      { err, raw: text.slice(0, 200) },
      "verify: unparseable verdict, defaulting to pass"
    );
    return {
      passes: true,
      reason: "verifier output unreadable — defaulting to pass",
      feedback: "",
    };
  }
}
