import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { initDb, getRecentWorkflowRuns, getAllKnowledge } from "./lib/db.js";
import { createVoiceProxy } from "./voice/proxy.js";
import { Render } from "@renderinc/sdk";

const app = new Hono();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

app.get("/health", (c) => c.json({ status: "ok", service: "ravendr-web" }));

app.get("/api/workflows/recent", async (c) => {
  try {
    const runs = await getRecentWorkflowRuns(10);
    return c.json(runs);
  } catch (err) {
    return c.json({ error: "Failed to fetch workflows" }, 500);
  }
});

app.get("/api/knowledge", async (c) => {
  try {
    const entries = await getAllKnowledge();
    return c.json(entries);
  } catch (err) {
    return c.json({ error: "Failed to fetch knowledge" }, 500);
  }
});

app.get("/api/report/:taskRunId", async (c) => {
  const { taskRunId } = c.req.param();
  try {
    const render = new Render();
    const details = await render.workflows.getTaskRun(taskRunId);
    if (details.status === "completed" && details.results.length > 0) {
      return c.json(details.results[0]);
    }
    return c.json({ status: details.status });
  } catch {
    return c.json({ error: "Task run not found" }, 404);
  }
});

app.use(
  "/*",
  serveStatic({
    root: "./src/static",
    rewriteRequestPath: (path) => {
      if (path === "/") return "/index.html";
      return path;
    },
  })
);

async function start() {
  try {
    await initDb();
    console.log("Database initialized");
  } catch (err) {
    console.warn("Database init skipped (will retry on first query):", (err as Error).message);
  }

  const server = createServer(app.fetch as unknown as Parameters<typeof createServer>[0]);

  const wss = new WebSocketServer({ server, path: "/ws/voice" });

  wss.on("connection", (clientWs: WebSocket) => {
    console.log("Voice client connected");
    createVoiceProxy(clientWs, (event) => {
      const t = event.type as string;
      if (t === "session.ready") console.log("Voice session ready");
      if (t === "error") console.error("Voice error:", event.message);
    });
  });

  server.listen(PORT, () => {
    console.log(`Ravendr server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
