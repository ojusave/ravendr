import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Render } from "@renderinc/sdk";
import { trackWorkflowRun, completeWorkflowRun, failWorkflowRun } from "../lib/db.js";

const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

export const recallTopicTool = createTool({
  id: "recall_topic",
  description:
    "Recall what the user knows about a topic. " +
    "Use this when the user asks 'what do I know about X?' or 'tell me about X' or wants a summary of stored knowledge. " +
    "This triggers a workflow that searches the knowledge base, checks freshness, and synthesizes a briefing.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("The topic or question to recall knowledge about"),
  }),
  outputSchema: z.object({
    briefing: z.string(),
    entryCount: z.number(),
    staleCount: z.number(),
  }),
  execute: async ({ query }) => {
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
      return {
        briefing: `I wasn't able to recall information about "${query}" right now. ${message}`,
        entryCount: 0,
        staleCount: 0,
      };
    }
  },
});
