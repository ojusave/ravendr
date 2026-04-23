import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { logger } from "./shared/logger.js";
import { buildRoutes } from "./routes.js";
import { createPostgresEventBus } from "./render/event-bus.js";
import { createWorkflowDispatcher } from "./render/workflow-dispatcher.js";
import { createSessionBroker } from "./render/session-broker.js";
import {
  listExpiredActiveSessions,
  markSessionClosed,
} from "./render/db.js";

/**
 * Composition root for the web service.
 *
 * Its entire job now:
 *   1. Serve static frontend + a handful of HTTP endpoints.
 *   2. Broker WebSockets: pair the browser's audio WS (/ws/client) with
 *      the workflow task's reverse WS (/ws/task) for the same sessionId.
 *      Forward bytes both directions. No AssemblyAI code here.
 *   3. Subscribe to Postgres phase_events and fan them out via SSE.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const events = createPostgresEventBus({
    connectionString: config.DATABASE_URL,
  });
  await events.start();
  const dispatcher = createWorkflowDispatcher({
    apiKey: config.RENDER_API_KEY,
    workflowSlug: config.WORKFLOW_SLUG,
  });
  const broker = createSessionBroker();

  const app = buildRoutes({
    databaseUrl: config.DATABASE_URL,
    events,
    dispatcher,
    broker,
    publicWebUrl: config.PUBLIC_WEB_URL,
    maxConcurrentSessions: config.MAX_CONCURRENT_SESSIONS,
    sessionLifetimeMinutes: config.SESSION_LIFETIME_MINUTES,
  });

  // ── Session cleanup daemon ────────────────────────────────────────
  // Every SESSION_PURGE_INTERVAL_MS, find sessions whose TTL passed but
  // whose voiceSession task is still running; cancel the task, mark the
  // session closed. Prevents slots from being stuck "active" forever if
  // a browser tab was closed without a graceful disconnect.
  let purgeStop = false;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const sig = AbortSignal.timeout(ms);
      if (sig.aborted) resolve();
      else sig.addEventListener("abort", () => resolve(), { once: true });
    });
  (async function purgeLoop() {
    while (!purgeStop) {
      await wait(config.SESSION_PURGE_INTERVAL_MS);
      if (purgeStop) break;
      try {
        const expired = await listExpiredActiveSessions(config.DATABASE_URL);
        if (expired.length === 0) continue;
        logger.info({ count: expired.length }, "purging expired sessions");
        for (const { id, taskRunId } of expired) {
          await dispatcher.cancelTaskRun(taskRunId);
          await markSessionClosed(config.DATABASE_URL, id);
        }
      } catch (err) {
        logger.error({ err }, "session purge tick failed");
      }
    }
  })();

  const server = serve(
    { fetch: app.fetch, port: config.PORT },
    (info) => logger.info({ port: info.port }, "ravendr-web listening")
  );

  // ── WebSocket upgrade: /ws/client (browser) + /ws/task (task) ────────
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, "http://x");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws/client") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        broker.registerClient(sessionId, ws);
      });
      return;
    }

    if (url.pathname === "/ws/task") {
      const token = url.searchParams.get("token") ?? "";
      wss.handleUpgrade(req, socket, head, (ws) => {
        const ok = broker.registerTask(sessionId, token, ws);
        if (!ok) ws.close();
      });
      return;
    }

    socket.destroy();
  });

  const shutdown = async () => {
    logger.info("shutting down");
    purgeStop = true;
    await events.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "fatal during startup");
  process.exit(1);
});
