import { Render } from "@renderinc/sdk";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface WorkflowDispatcherConfig {
  apiKey: string;
  workflowSlug: string;
}

export interface WorkflowDispatcher {
  /**
   * Starts the voiceSession task run. The task opens AssemblyAI and its
   * reverse WS back to this web service. Returns the Render taskRunId.
   */
  startVoiceSession(
    sessionId: string,
    taskToken: string,
    publicWebUrl: string
  ): Promise<string>;

  /** Cancels a still-running task. Used by the session-cleanup daemon. */
  cancelTaskRun(taskRunId: string): Promise<void>;
}

export function createWorkflowDispatcher(
  config: WorkflowDispatcherConfig
): WorkflowDispatcher {
  process.env.RENDER_API_KEY = config.apiKey;
  const render = new Render();

  return {
    async startVoiceSession(sessionId, taskToken, publicWebUrl) {
      try {
        const started = await render.workflows.startTask(
          `${config.workflowSlug}/voiceSession`,
          [sessionId, taskToken, publicWebUrl]
        );
        const runId = started.taskRunId;
        if (!runId) throw new AppError("UPSTREAM_WORKFLOW", "missing taskRunId");
        logger.info({ sessionId, runId }, "voiceSession dispatched");
        return runId;
      } catch (err) {
        logger.error({ err, sessionId }, "startVoiceSession failed");
        throw new AppError(
          "UPSTREAM_WORKFLOW",
          "failed to dispatch voiceSession task",
          { cause: err }
        );
      }
    },

    async cancelTaskRun(taskRunId) {
      try {
        await render.workflows.cancelTaskRun(taskRunId);
        logger.info({ taskRunId }, "task run cancelled");
      } catch (err) {
        // Non-fatal: cancellation can race with natural completion. The
        // cleanup daemon retries on next tick if still active.
        logger.warn({ err, taskRunId }, "cancelTaskRun failed");
      }
    },
  };
}
