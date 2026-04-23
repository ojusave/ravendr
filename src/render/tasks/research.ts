import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { createBriefing, setSessionStatus } from "../db.js";
import { logger } from "../../shared/logger.js";
import { classify_ask } from "./mastra/classify-ask.js";
import { plan_queries } from "./mastra/plan-queries.js";
import { search_branch, type BranchResult } from "./youcom/search-branch.js";
import { synthesize } from "./mastra/synthesize.js";
import { verify } from "./mastra/verify.js";

/**
 * Demo-grade deadline: whatever the pipeline has at this point, ship it.
 * AssemblyAI's voice handler will read whatever briefing we produce.
 *
 * Stages consume the budget in order; synth + verify + retry only run if
 * there's enough time left when the previous stage finishes.
 */
const OVERALL_BUDGET_MS = 55_000; // 55s leaves ~5s for broker + browser render
const SYNTH_RESERVE_MS = 12_000;   // minimum runway we need to actually write the briefing
const VERIFY_RESERVE_MS = 6_000;   // minimum runway for the verify step
const RETRY_RESERVE_MS = 35_000;   // don't even try a retry unless this much is left

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

      const deadline = Date.now() + OVERALL_BUDGET_MS;
      const remaining = () => Math.max(0, deadline - Date.now());

      // ── classify the ask up front so every downstream step adapts ──
      const { shape } = await classify_ask(sessionId, topic);

      let feedback = "";
      let attempt = 0;
      let result: Awaited<ReturnType<typeof synthesize>>;

      // Each loop iteration: plan → (deadline-capped) search → synth.
      // We only attempt the verify + retry pass if enough budget remains.
      while (true) {
        const plan = await plan_queries(sessionId, topic, feedback || undefined, shape);

        // Search fan-out with a deadline. Whichever branches finish before
        // the budget runs out contribute to the briefing. The rest keep
        // running in Render's infrastructure as orphaned subtask runs —
        // fine for a demo; those branches just don't make it in.
        const searchBudget = Math.max(5_000, remaining() - SYNTH_RESERVE_MS);
        const branches = await racePartial(
          plan.queries.map((q) =>
            Promise.resolve(search_branch(sessionId, q.angle, q.query, q.tier))
          ),
          searchBudget
        );

        if (branches.length < plan.queries.length) {
          logger.warn(
            {
              sessionId,
              got: branches.length,
              planned: plan.queries.length,
              remainingMs: remaining(),
            },
            "search fan-out truncated by deadline"
          );
        }

        // If nothing came back, seed with an empty branch so synthesize
        // doesn't throw — it'll produce a "couldn't find anything" briefing.
        const safeBranches: BranchResult[] =
          branches.length > 0
            ? branches
            : [
                {
                  angle: "overview",
                  query: topic,
                  tier: "standard",
                  content: "No research results came back in time.",
                  sources: [],
                  latencyMs: 0,
                },
              ];

        result = await synthesize(sessionId, briefingId, topic, safeBranches, shape);

        // Only verify if we have the runway. Otherwise ship what we have.
        if (remaining() < VERIFY_RESERVE_MS) {
          logger.warn(
            { sessionId, remainingMs: remaining() },
            "skipping verify — out of budget"
          );
          break;
        }

        const verdict = await verify(sessionId, topic, result.content, shape);

        if (verdict.passes || attempt >= 1) break;

        // Retry only if a full second pass could fit in what's left.
        if (remaining() < RETRY_RESERVE_MS) {
          logger.warn(
            { sessionId, remainingMs: remaining() },
            "verify failed but no budget for retry — shipping current briefing"
          );
          break;
        }

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

      // Pipeline settled (or deadline hit). Publish briefing.ready exactly
      // once so the UI renders and the voice agent reads the final briefing.
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

/**
 * Race a set of promises against a deadline. Returns whichever results
 * resolve before the timer fires — pending or rejected promises contribute
 * nothing. Never throws; bounded by budgetMs.
 *
 * Used for search fan-out: if 30 branches are in flight and only 18
 * finish before we run out of time, we synthesize from those 18.
 */
async function racePartial<T>(
  promises: Promise<T>[],
  budgetMs: number
): Promise<T[]> {
  const settled: Array<T | typeof PENDING> = promises.map(() => PENDING);
  const allDone = Promise.all(
    promises.map((p, i) =>
      p.then((r) => {
        settled[i] = r;
      }).catch(() => {
        /* failed branch contributes nothing */
      })
    )
  );
  await Promise.race([allDone, timer(budgetMs)]);
  return settled.filter((r): r is T => r !== PENDING);
}

const PENDING = Symbol("pending");

function timer(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const signal = AbortSignal.timeout(ms);
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
