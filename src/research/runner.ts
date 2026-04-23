import type { EventBus, ResearchProvider } from "../shared/ports.js";
import { createBriefing, setSessionStatus } from "../render/db.js";
import { getMastraMemory, threadForSession } from "../mastra/memory.js";
import { createBriefingWorkflow } from "./workflow.js";
import { logger } from "../shared/logger.js";
import { AppError } from "../shared/errors.js";

export interface RunBriefingPorts {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
  anthropicApiKey: string;
  anthropicModel: string;
}

export interface RunBriefingArgs {
  sessionId: string;
  topic: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Thin wrapper around the Mastra workflow.
 *
 *   1. Create the briefing row so we have an id to thread through.
 *   2. Spin up a Mastra workflow (plan → search → synthesize) and run it.
 *   3. On failure, mark the session and emit workflow.failed.
 *   4. Best-effort Mastra memory write for cross-session continuity.
 */
export async function runBriefing(
  args: RunBriefingArgs,
  ports: RunBriefingPorts
): Promise<{ briefingId: string; sourceCount: number }> {
  const { sessionId, topic, runId } = args;

  const briefingId = await createBriefing(ports.databaseUrl, sessionId, topic, runId);

  const workflow = createBriefingWorkflow(ports);

  try {
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { sessionId, topic, runId, briefingId },
    });

    // Mastra's run result shape varies slightly; accept either the output
    // directly or nested under `result` / `output`.
    const out =
      (result as { output?: unknown; result?: unknown } | undefined)?.output ??
      (result as { result?: unknown })?.result ??
      result;

    const typed = out as { briefingId?: string; sourceCount?: number };
    if (!typed?.briefingId) {
      throw new Error("workflow completed without a briefingId");
    }

    // ── Best-effort memory write for future sessions ────────────────
    writeMemorySummary(ports.databaseUrl, sessionId, topic).catch((err) =>
      logger.warn({ err }, "mastra memory write failed")
    );

    return {
      briefingId: typed.briefingId,
      sourceCount: typed.sourceCount ?? 0,
    };
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

async function writeMemorySummary(
  databaseUrl: string,
  sessionId: string,
  topic: string
): Promise<void> {
  let memory: ReturnType<typeof getMastraMemory> | null;
  try {
    memory = getMastraMemory({ databaseUrl });
  } catch {
    return;
  }
  const threadId = threadForSession(sessionId, "researcher");
  const summary = `User researched topic "${topic}" at ${new Date().toISOString()}.`;
  // Best-effort: Mastra's memory API varies by version. Try common shapes.
  const m = memory as unknown as {
    saveMessage?: (args: { threadId: string; content: string; role: string }) => Promise<unknown>;
    addMessage?: (args: { threadId: string; content: string; role: string }) => Promise<unknown>;
  };
  if (typeof m.saveMessage === "function") {
    await m.saveMessage({ threadId, content: summary, role: "system" });
  } else if (typeof m.addMessage === "function") {
    await m.addMessage({ threadId, content: summary, role: "system" });
  }
}
