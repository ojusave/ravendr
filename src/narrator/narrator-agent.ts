import type { EventBus } from "../shared/ports.js";
import type { PhaseEvent } from "../shared/events.js";
import { narrateEvent } from "./templates.js";
import { logger } from "../shared/logger.js";

export interface NarratorConfig {
  events: EventBus;
  sessionId: string;
}

/**
 * Narrator: subscribes to phase events for a session and emits `narrator.speech`
 * events that the ws-proxy relays to AssemblyAI via session.say().
 *
 * Template-driven — no LLM in v1. Every phase event maps to one short line.
 */
export function startNarrator(config: NarratorConfig): () => void {
  const { events, sessionId } = config;
  let lastSpeechAt = 0;

  const unsubscribe = events.subscribe(sessionId, async (event: PhaseEvent) => {
    if (event.kind === "narrator.speech") return; // don't echo ourselves

    const line = narrateEvent(event);
    if (!line) return;

    // Debounce: never more than one narration per 1500ms, for pacing.
    const now = Date.now();
    if (now - lastSpeechAt < 1_500) return;
    lastSpeechAt = now;

    try {
      await events.publish({
        kind: "narrator.speech",
        sessionId,
        at: Date.now(),
        text: line,
      });
    } catch (err) {
      logger.warn({ err }, "narrator publish failed");
    }
  });

  return unsubscribe;
}
