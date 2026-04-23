import type { EventBus } from "../shared/ports.js";
import { getBriefing } from "../render/db.js";
import { logger } from "../shared/logger.js";

export interface AwaitBriefingOpts {
  sessionId: string;
  events: EventBus;
  databaseUrl: string;
  /** Default: 5 minutes — longer than any reasonable You.com Deep + Lite pair. */
  timeoutMs?: number;
}

/**
 * Block until the session's research briefing is ready, then return its text
 * content. Throws on workflow.failed or timeout.
 *
 * Used by the AssemblyAI tool handler so the agent speaks the finished
 * briefing as its reply — keeping all voice output on AssemblyAI.
 */
export async function awaitBriefing(opts: AwaitBriefingOpts): Promise<string> {
  const { sessionId, events, databaseUrl } = opts;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const briefingId: string = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("briefing timeout — workflow did not complete in time"));
    }, timeoutMs);

    const unsubscribe = events.subscribe(sessionId, (event) => {
      if (event.kind === "briefing.ready") {
        clearTimeout(timer);
        unsubscribe();
        resolve(event.briefingId);
      } else if (event.kind === "workflow.failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(event.message));
      }
    });
  });

  const briefing = await getBriefing(databaseUrl, briefingId);
  if (!briefing?.content) {
    logger.warn({ sessionId, briefingId }, "briefing row missing content");
    return "The briefing finished but returned no content.";
  }
  return briefing.content;
}
