import type { EventBus, ResearchProvider, ResearchSource } from "../shared/ports.js";
import { VOICE_BRIEFING_PREAMBLE, RECENT_SCAN_PREAMBLE } from "./agent-prompts.js";
import { addSources, completeBriefing, createBriefing, setSessionStatus } from "../render/db.js";
import { logger } from "../shared/logger.js";
import { AppError } from "../shared/errors.js";

export interface RunBriefingPorts {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
}

export interface RunBriefingArgs {
  sessionId: string;
  topic: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Hero chain body. You.com does both the research AND the synthesis — we just
 * frame the query for voice, strip inline citation markers for TTS, persist.
 *
 *   emit(agent.planning) → You.com Standard (main briefing) →
 *   emit → You.com Lite (recent developments) → merge → persist → emit(briefing.ready)
 */
export async function runBriefing(
  args: RunBriefingArgs,
  ports: RunBriefingPorts
): Promise<{ briefingId: string; sourceCount: number }> {
  const { sessionId, topic, runId, signal } = args;
  const { research, events, databaseUrl } = ports;

  const briefingId = await createBriefing(databaseUrl, sessionId, topic, runId);

  const emit = (event: Parameters<EventBus["publish"]>[0]) =>
    events.publish(event).catch((err) => logger.warn({ err }, "emit failed"));

  try {
    await emit({
      sessionId,
      at: Date.now(),
      kind: "agent.planning",
      step: "decomposing_topic",
    });

    // ── main briefing (voice-oriented) ────────────────────────────
    const mainQuery = `${VOICE_BRIEFING_PREAMBLE}\n\nTopic: ${topic}`;
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.started",
      query: mainQuery,
      tier: "standard",
    });
    const main = await research.research({
      query: mainQuery,
      tier: "standard",
      signal,
    });
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.completed",
      query: mainQuery,
      tier: "standard",
      sourceCount: main.sources.length,
      latencyMs: main.latencyMs,
    });

    // ── recency scan (cheap) ──────────────────────────────────────
    const recentQuery = `${RECENT_SCAN_PREAMBLE}\n\nTopic: ${topic}`;
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.started",
      query: recentQuery,
      tier: "lite",
    });
    const recent = await research.research({
      query: recentQuery,
      tier: "lite",
      signal,
    });
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.completed",
      query: recentQuery,
      tier: "lite",
      sourceCount: recent.sources.length,
      latencyMs: recent.latencyMs,
    });

    // ── merge + strip inline citations so TTS reads naturally ─────
    await emit({ sessionId, at: Date.now(), kind: "agent.synthesizing" });
    const body = stripCitationMarkers(main.content);
    const recentBlock = recent.content.trim()
      ? `\n\nRecent developments:\n${stripCitationMarkers(recent.content)}`
      : "";
    const briefingContent = `${body}${recentBlock}`;

    const allSources = mergeSources([...main.sources, ...recent.sources]);

    await completeBriefing(databaseUrl, briefingId, briefingContent);
    await addSources(databaseUrl, briefingId, allSources);
    await setSessionStatus(databaseUrl, sessionId, "complete");

    await emit({
      sessionId,
      at: Date.now(),
      kind: "briefing.ready",
      briefingId,
      sourceCount: allSources.length,
    });

    return { briefingId, sourceCount: allSources.length };
  } catch (err) {
    logger.error({ err, sessionId }, "runBriefing failed");
    await setSessionStatus(databaseUrl, sessionId, "error").catch(() => {});
    await emit({
      sessionId,
      at: Date.now(),
      kind: "workflow.failed",
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw AppError.from(err, "UPSTREAM_WORKFLOW");
  }
}

/**
 * You.com emits inline markers like `[[1, 2]]` / `[1]` / `[1, 2, 3]`. They
 * read badly through TTS ("bracket one comma two bracket"). Strip them —
 * sources still appear on screen via the sources[] array.
 */
function stripCitationMarkers(md: string): string {
  return md
    .replace(/\[\[\s*\d+(?:\s*,\s*\d+)*\s*\]\]/g, "") // [[1, 2]]
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")    // [1] / [1, 2]
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mergeSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
