import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../config.js";
import { createYouComResearch } from "../../youcom/research.js";
import { createPostgresEventBus } from "../event-bus.js";
import { runBriefing } from "../../research/runner.js";
import { logger } from "../../shared/logger.js";

/**
 * The hero-chain task body. Invoked by Render Workflows when
 * `ravendr-tasks/research` is dispatched from the Web Service.
 *
 * Composes its own adapters because tasks run in isolated instances with no
 * shared process state.
 */
export const research = task(
  {
    name: "research",
    plan: "starter",
    timeoutSeconds: 400,
    retry: { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function research(
    sessionId: string,
    topic: string
  ): Promise<{ briefingId: string; sourceCount: number }> {
    logger.info({ sessionId, topic }, "research task start");
    const config = loadWorkflowConfig();

    const yresearch = createYouComResearch({
      apiKey: config.YOU_API_KEY,
      baseUrl: config.YOU_BASE_URL,
    });
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      const runId = process.env.RENDER_TASK_RUN_ID ?? `local-${Date.now()}`;

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.started",
        runId,
      });

      const result = await runBriefing(
        { sessionId, topic, runId },
        {
          research: yresearch,
          events,
          databaseUrl: config.DATABASE_URL,
          anthropicModel: config.ANTHROPIC_MODEL,
        }
      );

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.completed",
        runId,
        briefingId: result.briefingId,
      });
      return result;
    } finally {
      await events.stop();
    }
  }
);
