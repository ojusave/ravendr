import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../../config.js";
import { createPostgresEventBus } from "../../event-bus.js";
import { createYouComResearch } from "../../../youcom/research.js";
import type { Tier } from "../../../shared/events.js";

export interface BranchResult {
  angle: string;
  query: string;
  tier: Tier;
  content: string;
  sources: { url: string; title: string; snippet?: string }[];
  latencyMs: number;
}

/**
 * Render Workflow leaf task: one You.com Research API call.
 *
 * Its own task run means retry is per-branch — if search #3 fails, only
 * #3 retries. Other parallel branches and the earlier plan step are
 * untouched. This is the checkpoint the user cares about.
 */
export const search_branch = task(
  {
    name: "search_branch",
    plan: "starter",
    timeoutSeconds: 180,
    retry: { maxRetries: 2, waitDurationMs: 1_500, backoffScaling: 2 },
  },
  async function search_branch(
    sessionId: string,
    angle: string,
    query: string,
    tier: Tier
  ): Promise<BranchResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    const research = createYouComResearch({
      apiKey: config.YOU_API_KEY,
      baseUrl: config.YOU_BASE_URL,
    });

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "youcom.call.started",
        query,
        tier,
      });

      const r = await research.research({ query, tier });

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "youcom.call.completed",
        query,
        tier,
        sourceCount: r.sources.length,
        latencyMs: r.latencyMs,
      });

      return {
        angle,
        query,
        tier,
        content: r.content,
        sources: r.sources,
        latencyMs: r.latencyMs,
      };
    } finally {
      await events.stop();
    }
  }
);
