import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { createBriefing, setSessionStatus } from "../db.js";
import { logger } from "../../shared/logger.js";
import { classify_ask } from "./classify-ask.js";
import { plan_queries } from "./plan-queries.js";
import { search_branch, type BranchResult } from "./search-branch.js";
import { synthesize } from "./synthesize.js";
import { verify } from "./verify.js";

export interface ResearchResult {
  briefingId: string;
  sourceCount: number;
  content: string;
}

/**
 * Orchestrates the research pipeline. Every `await` below dispatches a
 * new Render task run — failures checkpoint at that boundary.
 *
 *   plan_queries    (Mastra — pick angles)
 *   search_branch   (You.com — parallel × N)
 *   synthesize      (Mastra — write briefing)
 *   verify          (Mastra — does the briefing address the ask?)
 *   on verify.fail: one retry with the verifier's feedback baked into
 *   the next plan_queries call.
 */
export const research = task(
  {
    name: "research",
    plan: "starter",
    timeoutSeconds: 900, // wider since verify + retry can take longer
    retry: { maxRetries: 0, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function research(
    sessionId: string,
    topic: string
  ): Promise<ResearchResult> {
    logger.info({ sessionId, topic }, "research: start");
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    const runId = process.env.RENDER_TASK_RUN_ID ?? `local-${Date.now()}`;
    const briefingId = await createBriefing(
      config.DATABASE_URL,
      sessionId,
      topic,
      runId
    );

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.started",
        runId,
      });

      // ── classify the ask up front so every downstream step adapts ──
      const { shape } = await classify_ask(sessionId, topic);

      let feedback = "";
      let attempt = 0;
      let result: Awaited<ReturnType<typeof synthesize>>;

      // Run the pipeline once; if verify fails, run it one more time with
      // the verifier's feedback feeding into the planner. briefing.ready is
      // NOT emitted until AFTER this loop settles, so the UI and voice agent
      // only ever see the final briefing.
      while (true) {
        const plan = await plan_queries(sessionId, topic, feedback || undefined);

        const branches: BranchResult[] = await Promise.all(
          plan.queries.map((q) =>
            search_branch(sessionId, q.angle, q.query, q.tier)
          )
        );

        result = await synthesize(sessionId, briefingId, topic, branches, shape);

        const verdict = await verify(sessionId, topic, result.content, shape);

        if (verdict.passes || attempt >= 1) break;

        attempt += 1;
        feedback = verdict.feedback || verdict.reason || "";
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "research.retrying",
          attempt,
          feedback: feedback.slice(0, 500),
        });
      }

      // Pipeline settled — publish briefing.ready (UI renders, voice reads)
      // and then workflow.completed.
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "briefing.ready",
        briefingId: result.briefingId,
        sourceCount: result.sourceCount,
      });
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.completed",
        runId,
        briefingId: result.briefingId,
      });

      return result;
    } catch (err) {
      logger.error({ err, sessionId }, "research: failed");
      await setSessionStatus(config.DATABASE_URL, sessionId, "error").catch(
        () => {}
      );
      await events
        .publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.failed",
          runId,
          message: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
      throw err;
    } finally {
      await events.stop();
    }
  }
);
