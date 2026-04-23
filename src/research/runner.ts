import type { EventBus, ResearchProvider } from "../shared/ports.js";
import { createBriefing, setSessionStatus } from "../render/db.js";
import { createResearchAgent } from "./agent.js";
import { logger } from "../shared/logger.js";
import { AppError } from "../shared/errors.js";

export interface RunBriefingPorts {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
  anthropicModel: string;
}

export interface RunBriefingArgs {
  sessionId: string;
  topic: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Runs the Mastra Agent research loop inside a Render Workflow task.
 *
 * The agent autonomously calls plan_queries → search_web (parallel per
 * query) → write_briefing. Each tool publishes phase events that the voice
 * polling loop consumes for live narration.
 */
export async function runBriefing(
  args: RunBriefingArgs,
  ports: RunBriefingPorts
): Promise<{ briefingId: string; sourceCount: number }> {
  const { sessionId, topic, runId } = args;

  const briefingId = await createBriefing(
    ports.databaseUrl,
    sessionId,
    topic,
    runId
  );

  const agent = createResearchAgent({
    research: ports.research,
    events: ports.events,
    databaseUrl: ports.databaseUrl,
    anthropicModel: ports.anthropicModel,
    sessionId,
    briefingId,
  });

  try {
    const result = await agent.generate(
      `Research this topic for me: ${topic}`,
      { maxSteps: 20 }
    );

    // write_briefing is what persists and emits briefing.ready. If the agent
    // didn't call it (misbehavior), fall back to whatever text it returned.
    const writeBriefingResult = findWriteBriefingResult(result);
    if (writeBriefingResult) {
      return writeBriefingResult;
    }

    // Fallback: agent returned text without calling write_briefing.
    logger.warn(
      { sessionId, topic },
      "agent skipped write_briefing — using free-form text"
    );
    throw new Error("Agent did not call write_briefing");
  } catch (err) {
    logger.error({ err, sessionId }, "runBriefing failed");
    await setSessionStatus(ports.databaseUrl, sessionId, "error").catch(() => {});
    await ports.events
      .publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.failed",
        runId,
        message: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    throw AppError.from(err, "UPSTREAM_WORKFLOW");
  }
}

/**
 * Mastra's generate() result includes a `toolResults` array. Find the
 * write_briefing entry and return its output.
 */
function findWriteBriefingResult(
  result: unknown
): { briefingId: string; sourceCount: number } | null {
  const r = result as {
    toolResults?: Array<{ toolName?: string; result?: unknown }>;
  };
  if (!Array.isArray(r?.toolResults)) return null;
  for (const t of r.toolResults) {
    if (t.toolName === "write_briefing") {
      const out = t.result as { briefingId?: string; sourceCount?: number };
      if (out?.briefingId) {
        return {
          briefingId: out.briefingId,
          sourceCount: out.sourceCount ?? 0,
        };
      }
    }
  }
  return null;
}
