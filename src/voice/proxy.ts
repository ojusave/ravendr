import { WebSocket as WS } from "ws";
import { ASSEMBLYAI_WS_URL, SESSION_CONFIG } from "./config.js";
import { Render } from "@renderinc/sdk";
import {
  trackWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
  getRecentWorkflowRuns,
  searchKnowledge,
} from "../lib/db.js";

const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

type ToolArgs = Record<string, unknown>;

async function handleLearnTopic(args: ToolArgs) {
  const topic = args.topic as string;
  const claim = args.claim as string;
  const render = new Render();
  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/ingest`,
    [topic, claim]
  );
  await trackWorkflowRun({
    id: started.taskRunId,
    type: "ingest",
    input: { topic, claim },
  });
  return {
    taskRunId: started.taskRunId,
    message: `Started learning about "${topic}". The research is running in the background.`,
  };
}

async function handleRecallTopic(args: ToolArgs) {
  const query = args.query as string;
  const render = new Render();
  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/recall`,
    [query]
  );
  await trackWorkflowRun({
    id: started.taskRunId,
    type: "recall",
    input: { query },
  });
  try {
    const finished = await started.get();
    const result = finished.results[0] as {
      briefing: string;
      entryCount: number;
      staleCount: number;
    };
    await completeWorkflowRun(started.taskRunId, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Recall failed";
    await failWorkflowRun(started.taskRunId, message);
    return { briefing: `Couldn't recall info about "${query}". ${message}`, entryCount: 0, staleCount: 0 };
  }
}

async function handleGenerateReport() {
  const render = new Render();
  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/report`,
    []
  );
  await trackWorkflowRun({
    id: started.taskRunId,
    type: "report",
    input: {},
  });
  return {
    taskRunId: started.taskRunId,
    message: "Started generating a synthesis report. This may take a minute or two.",
  };
}

async function handleCheckStatus(args: ToolArgs) {
  const taskRunId = args.taskRunId as string | undefined;
  const render = new Render();
  if (taskRunId) {
    try {
      const details = await render.workflows.getTaskRun(taskRunId);
      return { status: details.status, details: `Task ${taskRunId} is ${details.status}.` };
    } catch {
      return { status: "unknown", details: `Could not find task run ${taskRunId}.` };
    }
  }
  const recent = await getRecentWorkflowRuns(5);
  if (recent.length === 0) return { status: "empty", details: "No recent workflow activity." };
  const running = recent.filter((r) => r.status === "running");
  return {
    status: running.length > 0 ? `${running.length} running` : "all done",
    details: recent
      .map((r) => `${r.type}: ${r.status}`)
      .join(", "),
  };
}

const toolHandlers: Record<string, (args: ToolArgs) => Promise<unknown>> = {
  learn_topic: handleLearnTopic,
  recall_topic: handleRecallTopic,
  generate_report: handleGenerateReport,
  check_status: handleCheckStatus,
};

/**
 * Creates a proxy WebSocket connection between a browser client and AssemblyAI.
 * Handles tool calls by routing them to Render Workflows.
 */
export function createVoiceProxy(
  clientWs: WS,
  onEvent?: (event: Record<string, unknown>) => void
) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    clientWs.send(
      JSON.stringify({
        type: "error",
        message: "ASSEMBLYAI_API_KEY not configured",
      })
    );
    clientWs.close();
    return;
  }

  const assemblyWs = new WS(ASSEMBLYAI_WS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const pendingTools: { call_id: string; result: unknown }[] = [];

  assemblyWs.on("open", () => {
    assemblyWs.send(
      JSON.stringify({
        type: "session.update",
        session: SESSION_CONFIG,
      })
    );
  });

  assemblyWs.on("message", async (data: Buffer) => {
    const event = JSON.parse(data.toString()) as Record<string, unknown>;
    const eventType = event.type as string;

    onEvent?.(event);

    if (eventType === "tool.call") {
      const name = event.name as string;
      const args = (event.args ?? {}) as ToolArgs;
      const callId = event.call_id as string;

      const handler = toolHandlers[name];
      let result: unknown;

      if (handler) {
        try {
          result = await handler(args);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : "Tool execution failed",
          };
        }
      } else {
        result = { error: `Unknown tool: ${name}` };
      }

      pendingTools.push({ call_id: callId, result });
    } else if (eventType === "reply.done") {
      const status = event.status as string | undefined;
      if (status === "interrupted") {
        pendingTools.length = 0;
      } else if (pendingTools.length > 0) {
        for (const tool of pendingTools) {
          assemblyWs.send(
            JSON.stringify({
              type: "tool.result",
              call_id: tool.call_id,
              result: JSON.stringify(tool.result),
            })
          );
        }
        pendingTools.length = 0;
      }
    }

    if (eventType !== "tool.call" && clientWs.readyState === WS.OPEN) {
      clientWs.send(data.toString());
    }
  });

  assemblyWs.on("error", (err) => {
    console.error("AssemblyAI WS error:", err.message);
    if (clientWs.readyState === WS.OPEN) {
      clientWs.send(
        JSON.stringify({ type: "error", message: "Voice connection error" })
      );
    }
  });

  assemblyWs.on("close", () => {
    if (clientWs.readyState === WS.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on("message", (data: Buffer) => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.send(data.toString());
    }
  });

  clientWs.on("close", () => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.close();
    }
  });

  clientWs.on("error", () => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.close();
    }
  });
}
