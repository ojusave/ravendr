import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { EventBus } from "./shared/ports.js";
import type { WorkflowDispatcher } from "./render/workflow-dispatcher.js";
import type { SessionBroker } from "./render/session-broker.js";
import {
  createSession,
  getBriefing,
  listSources,
} from "./render/db.js";
import { ok, fail } from "./shared/envelope.js";
import { AppError } from "./shared/errors.js";
import { logger } from "./shared/logger.js";

export interface RoutesDeps {
  databaseUrl: string;
  events: EventBus;
  dispatcher: WorkflowDispatcher;
  broker: SessionBroker;
  /** Optional override — used when Render doesn't inject RENDER_EXTERNAL_URL (local dev). */
  publicWebUrl?: string;
}

/**
 * HTTP routes. WebSockets (/ws/client, /ws/task) are handled by server.ts
 * via the broker — not here.
 */
export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "ravendr-web" }));

  // POST /api/start — create session, dispatch voiceSession task, return id.
  app.post("/api/start", async (c) => {
    try {
      const session = await createSession(deps.databaseUrl, null);
      const sessionId = session.id;
      const token = deps.broker.issueToken(sessionId);

      // Prefer Render's auto-set public URL; fall back to PUBLIC_WEB_URL, then
      // derive from the incoming request host (handy for local dev / previews).
      const publicWebUrl =
        process.env.RENDER_EXTERNAL_URL ??
        deps.publicWebUrl ??
        inferUrlFromRequest(c);

      const runId = await deps.dispatcher.startVoiceSession(
        sessionId,
        token,
        publicWebUrl
      );
      return c.json(ok({ sessionId, runId }));
    } catch (err) {
      return respondError(c, err);
    }
  });

  // SSE stream — phase events for the activity feed.
  app.get("/api/sessions/:id/events", (c) => {
    const sessionId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const unsubscribe = deps.events.subscribe(sessionId, (event) => {
        stream
          .writeSSE({
            event: "phase",
            data: JSON.stringify(event),
            id: String(event.at),
          })
          .catch(() => {});
      });
      stream.onAbort(() => unsubscribe());
      await new Promise<void>(() => {});
    });
  });

  // Fetch a finished briefing + its sources.
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

  // Static frontend.
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

function inferUrlFromRequest(c: Context): string {
  const host = c.req.header("host") ?? "localhost:3000";
  const proto =
    c.req.header("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
