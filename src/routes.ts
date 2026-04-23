import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { EventBus } from "./shared/ports.js";
import type { WorkflowDispatcher } from "./render/workflow-dispatcher.js";
import type { SessionBroker } from "./render/session-broker.js";
import {
  countActiveSessions,
  createSession,
  getBriefing,
  getSession,
  listSources,
  setSessionTaskRun,
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
  /** Hard cap on concurrently-active voiceSession tasks. */
  maxConcurrentSessions: number;
  /** Minutes before a session's task is auto-cancelled by the cleanup daemon. */
  sessionLifetimeMinutes: number;
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
      // Concurrent-session cap. Returns 503 if at capacity — frontend shows
      // a "demo is busy, try again shortly" message instead of a dead
      // "Connecting…" state that would happen if we oversubscribed.
      const active = await countActiveSessions(deps.databaseUrl);
      if (active >= deps.maxConcurrentSessions) {
        logger.warn(
          { active, cap: deps.maxConcurrentSessions },
          "session cap reached — rejecting new /api/start"
        );
        c.status(503);
        return c.json(
          fail(
            new AppError(
              "AT_CAPACITY",
              `Demo is at capacity (${active}/${deps.maxConcurrentSessions} sessions active). Try again in a minute.`
            )
          )
        );
      }

      const session = await createSession(
        deps.databaseUrl,
        null,
        deps.sessionLifetimeMinutes
      );
      const sessionId = session.id;
      const token = deps.broker.issueToken(sessionId);

      // The browser is hitting us right now — its Host header is guaranteed
      // to be the public URL the task also needs to reach. That's the most
      // reliable source. Env vars are just a fallback.
      const publicWebUrl =
        inferUrlFromRequest(c) ??
        process.env.RENDER_EXTERNAL_URL ??
        deps.publicWebUrl ??
        `http://localhost:3000`;
      logger.info({ publicWebUrl, sessionId, active }, "dispatching voiceSession");

      const runId = await deps.dispatcher.startVoiceSession(
        sessionId,
        token,
        publicWebUrl
      );
      await setSessionTaskRun(deps.databaseUrl, sessionId, runId);

      return c.json(
        ok({
          sessionId,
          runId,
          expiresAt: session.expiresAt?.toISOString(),
          lifetimeMinutes: deps.sessionLifetimeMinutes,
        })
      );
    } catch (err) {
      return respondError(c, err);
    }
  });

  // GET /api/sessions/:id — return expiry / status for the countdown timer.
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const session = await getSession(deps.databaseUrl, id);
      if (!session) throw new AppError("NOT_FOUND", "session not found");
      return c.json(
        ok({
          id: session.id,
          status: session.status,
          expiresAt: session.expiresAt?.toISOString(),
          closedAt: session.closedAt?.toISOString(),
          lifetimeMinutes: deps.sessionLifetimeMinutes,
        })
      );
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

function inferUrlFromRequest(c: Context): string | null {
  const host = c.req.header("host");
  if (!host) return null;
  const proto =
    c.req.header("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
