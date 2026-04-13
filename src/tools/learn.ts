import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Render } from "@renderinc/sdk";
import { trackWorkflowRun } from "../lib/db.js";

const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

export const learnTopicTool = createTool({
  id: "learn_topic",
  description:
    "Learn about a topic by triggering a background research workflow. " +
    "Use this when the user discusses a topic, makes a claim, or wants to learn something new. " +
    "The workflow runs fact-checking and deep research in parallel, then stores the knowledge.",
  inputSchema: z.object({
    topic: z
      .string()
      .describe("The topic to learn about, e.g. 'quantum computing'"),
    claim: z
      .string()
      .describe(
        "The specific claim or statement the user made about the topic"
      ),
  }),
  outputSchema: z.object({
    taskRunId: z.string(),
    message: z.string(),
  }),
  execute: async ({ topic, claim }) => {
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
  },
});
