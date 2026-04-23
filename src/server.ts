import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { logger } from "./shared/logger.js";
import { buildRoutes } from "./routes.js";
import { createYouComResearch } from "./youcom/research.js";
import { createAssemblyAIRuntime } from "./assemblyai/runtime.js";
import { wireVoiceSession } from "./assemblyai/ws-proxy.js";
import { createPostgresEventBus } from "./render/event-bus.js";
import { createWorkflowDispatcher } from "./render/workflow-dispatcher.js";
import { setSessionTopic, setSessionStatus } from "./render/db.js";

/**
 * Composition root. Wires ports to adapters, starts Hono + WebSocket upgrade,
 * boots the Postgres LISTEN loop.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const research = createYouComResearch({
    apiKey: config.YOUCOM_API_KEY,
    baseUrl: config.YOUCOM_BASE_URL,
  });
  const voice = createAssemblyAIRuntime({
    apiKey: config.ASSEMBLYAI_API_KEY,
    agentUrl: config.ASSEMBLYAI_AGENT_URL,
    voice: config.ASSEMBLYAI_VOICE,
  });
  const events = createPostgresEventBus({ connectionString: config.DATABASE_URL });
  await events.start();
  const dispatcher = createWorkflowDispatcher({
    apiKey: config.RENDER_API_KEY,
    workflowSlug: config.WORKFLOW_SLUG,
  });

  const app = buildRoutes({
    databaseUrl: config.DATABASE_URL,
    events,
    voice,
    research,
    dispatcher,
  });

  const server = serve(
    { fetch: app.fetch, port: config.PORT },
    (info) => logger.info({ port: info.port }, "ravendr-web listening")
  );

  // ── WebSocket upgrade for /ws ─────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, "http://x");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wireVoiceSession({
        browser: ws,
        sessionId,
        voice,
        events,
        onUserTurn: async (topic: string) => {
          try {
            await setSessionTopic(config.DATABASE_URL, sessionId, topic);
            await setSessionStatus(config.DATABASE_URL, sessionId, "researching");
            await events.publish({
              sessionId,
              at: Date.now(),
              kind: "session.started",
              topic,
            });
            const runId = await dispatcher.dispatchResearch({ sessionId, topic });
            await events.publish({
              sessionId,
              at: Date.now(),
              kind: "workflow.dispatched",
              runId,
            });
            return `Got it. Researching ${topic}. You'll hear updates as we go.`;
          } catch (err) {
            logger.error({ err, sessionId, topic }, "voice dispatch failed");
            return "I hit an issue dispatching that research. Try again in a moment.";
          }
        },
      }).catch((err) => logger.error({ err }, "wireVoiceSession failed"));
    });
  });

  // ── graceful shutdown ─────────────────────────────────────────────
  const shutdown = async () => {
    logger.info("shutting down");
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
