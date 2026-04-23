import type { EventBus } from "./ports.js";
import type { PhaseEvent, PhaseEventKind } from "./events.js";

/**
 * Block until a phase event matching `kind` (+ optional filter) arrives on
 * the bus for the given session. Throws if `timeoutMs` elapses first, or if
 * a workflow.failed event arrives before the target event.
 */
export function waitForEvent<K extends PhaseEventKind>(opts: {
  events: EventBus;
  sessionId: string;
  kind: K;
  filter?: (event: Extract<PhaseEvent, { kind: K }>) => boolean;
  timeoutMs?: number;
}): Promise<Extract<PhaseEvent, { kind: K }>> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for ${opts.kind}`));
    }, timeoutMs);

    const unsubscribe = opts.events.subscribe(opts.sessionId, (event) => {
      if (event.kind === "workflow.failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(event.message));
        return;
      }
      if (event.kind !== opts.kind) return;
      const typed = event as Extract<PhaseEvent, { kind: K }>;
      if (opts.filter && !opts.filter(typed)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(typed);
    });
  });
}
