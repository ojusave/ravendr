import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { EventBus, ResearchProvider, VoiceRuntime } from "./shared/ports.js";
import type { WorkflowDispatcher } from "./render/workflow-dispatcher.js";
import {
  createSession,
  getBriefing,
  listSources,
  setSessionStatus,
  setSessionTopic,
} from "./render/db.js";
import { attachNarrator } from "./narrator/session.js";
import { ok, fail } from "./shared/envelope.js";
import { AppError } from "./shared/errors.js";
import { logger } from "./shared/logger.js";

export interface RoutesDeps {
  databaseUrl: string;
  events: EventBus;
  voice: VoiceRuntime;
  research: ResearchProvider;
  dispatcher: WorkflowDispatcher;
}

/**
 * All HTTP routes. WebSocket upgrade is handled outside Hono in server.ts.
 * Routes are resource-based and return the canonical { data, error, meta } envelope.
 */
export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();

  // ── health ────────────────────────────────────────────────────────
  app.get("/health", (c) => c.json({ ok: true, service: "ravendr-web" }));

  // ── session lifecycle ────────────────────────────────────────────
  app.post("/api/sessions", async (c) => {
    try {
      const session = await createSession(deps.databaseUrl, null);
      return c.json(ok({ sessionId: session.id }));
    } catch (err) {
      return respondError(c, err);
    }
  });

  // ── dispatch research (voice tool.call or HTTP equivalent) ───────
  app.post("/api/sessions/:id/dispatch", async (c) => {
    const sessionId = c.req.param("id");
    try {
      const body = (await c.req
        .json<{ topic?: string }>()
        .catch(() => ({} as { topic?: string }))) as { topic?: string };
      const topic = typeof body.topic === "string" ? body.topic.trim() : "";
      if (!topic) throw new AppError("VALIDATION", "topic is required");

      await setSessionTopic(deps.databaseUrl, sessionId, topic);
      await setSessionStatus(deps.databaseUrl, sessionId, "researching");

      await deps.events.publish({
        sessionId,
        at: Date.now(),
        kind: "session.started",
        topic,
      });

      const runId = await deps.dispatcher.dispatchResearch({ sessionId, topic });
      await deps.events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.dispatched",
        runId,
      });

      return c.json(ok({ sessionId, runId }));
    } catch (err) {
      return respondError(c, err);
    }
  });

  // ── phase-event SSE stream ────────────────────────────────────────
  app.get("/api/sessions/:id/events", (c) => {
    const sessionId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const narrator = attachNarrator({
        sessionId,
        events: deps.events,
      });

      const unsubscribe = deps.events.subscribe(sessionId, (event) => {
        stream
          .writeSSE({
            event: "phase",
            data: JSON.stringify(event),
            id: String(event.at),
          })
          .catch(() => {});
      });

      const cleanup = () => {
        unsubscribe();
        narrator.dispose();
      };
      stream.onAbort(cleanup);

      // Keep open indefinitely — client closes via AbortController.
      await new Promise<void>(() => {});
    });
  });

  // ── briefing read ────────────────────────────────────────────────
  app.get("/api/briefings/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const briefing = await getBriefing(deps.databaseUrl, id);
      if (!briefing) throw new AppError("NOT_FOUND", "briefing not found");
      const sources = await listSources(deps.databaseUrl, id);
      return c.json(ok({ briefing, sources }));
    } catch (err) {
      return respondError(c, err);
    }
  });

  // ── static frontend (plain ES modules, no build step) ────────────
  app.get("/", serveStatic({ path: "./static/index.html" }));
  app.use("/*", serveStatic({ root: "./static" }));

  return app;
}

function respondError(c: Context, err: unknown) {
  const appErr = AppError.from(err);
  logger.warn({ err: appErr }, "request failed");
  c.status(appErr.status as 400 | 404 | 500 | 502 | 504);
  return c.json(fail(appErr));
}
