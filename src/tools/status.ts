import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Render } from "@renderinc/sdk";
import {
  getRecentWorkflowRuns,
  completeWorkflowRun,
  failWorkflowRun,
} from "../lib/db.js";

export const checkStatusTool = createTool({
  id: "check_status",
  description:
    "Check the status of recent workflow runs. " +
    "Use this when the user asks 'is it done?', 'what's the status?', or 'is my research ready?'. " +
    "Can check a specific task run ID or show recent activity.",
  inputSchema: z.object({
    taskRunId: z
      .string()
      .optional()
      .describe(
        "Specific task run ID to check. If omitted, shows recent activity."
      ),
  }),
  outputSchema: z.object({
    status: z.string(),
    details: z.string(),
  }),
  execute: async ({ taskRunId }) => {
    const render = new Render();

    if (taskRunId) {
      try {
        const details = await render.workflows.getTaskRun(taskRunId);

        if (details.status === "completed" && details.results.length > 0) {
          await completeWorkflowRun(taskRunId, details.results[0] as Record<string, unknown>);
        } else if (details.status === "failed") {
          await failWorkflowRun(taskRunId, details.error ?? "Unknown error");
        }

        return {
          status: details.status,
          details: formatTaskDetails(details),
        };
      } catch {
        return {
          status: "unknown",
          details: `Could not find task run ${taskRunId}.`,
        };
      }
    }

    const recent = await getRecentWorkflowRuns(5);
    if (recent.length === 0) {
      return {
        status: "empty",
        details: "No recent workflow activity.",
      };
    }

    const summary = recent
      .map(
        (r) =>
          `${r.type} (${r.id.slice(0, 8)}...): ${r.status} — ${new Date(r.created_at).toLocaleTimeString()}`
      )
      .join("\n");

    const running = recent.filter((r) => r.status === "running");
    const status =
      running.length > 0
        ? `${running.length} task(s) still running`
        : "All recent tasks completed";

    return { status, details: summary };
  },
});

function formatTaskDetails(details: {
  status: string;
  results: unknown[];
  error?: string;
}): string {
  if (details.status === "completed") {
    const result = details.results[0];
    if (result && typeof result === "object" && "briefing" in result) {
      return (result as { briefing: string }).briefing;
    }
    if (result && typeof result === "object" && "title" in result) {
      return `Report ready: "${(result as { title: string }).title}"`;
    }
    return "Task completed successfully.";
  }
  if (details.status === "failed") {
    return `Task failed: ${details.error ?? "unknown error"}`;
  }
  return `Task is ${details.status}.`;
}
