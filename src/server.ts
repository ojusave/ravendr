import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { initDb, getRecentWorkflowRuns, getAllKnowledge } from "./lib/db.js";
import { createVoiceProxy } from "./voice/proxy.js";
import { Render } from "@renderinc/sdk";
import {
  runIngestPipeline,
  runRecallPipeline,
  runReportPipeline,
} from "./pipeline/orchestrator.js";
import { getRenderDashboardTasksUrl } from "./lib/render-dashboard-url.js";

const app = new Hono();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

function isTaskSuccess(status: string): boolean {
  return status === "completed" || status === "succeeded";
}

app.get("/health", (c) => c.json({ status: "ok", service: "ravendr-web" }));

app.get("/api/config", (c) =>
  c.json({
    dashboardTasksUrl: getRenderDashboardTasksUrl(),
  })
);

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
    if (isTaskSuccess(details.status) && details.results.length > 0) {
      return c.json(details.results[0]);
    }
    return c.json({ status: details.status });
  } catch {
    return c.json({ error: "Task run not found" }, 404);
  }
});

app.post("/api/pipeline/ingest", async (c) => {
  c.header("X-Accel-Buffering", "no");
  let body: { topic?: string; claim?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.topic?.trim() || !body.claim?.trim()) {
    return c.json({ error: "topic and claim are required" }, 400);
  }
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runIngestPipeline(
        body.topic!.trim(),
        body.claim!.trim(),
        signal
      )) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
});

app.post("/api/pipeline/recall", async (c) => {
  c.header("X-Accel-Buffering", "no");
  let body: { query?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.query?.trim()) {
    return c.json({ error: "query is required" }, 400);
  }
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runRecallPipeline(body.query!.trim(), signal)) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
});

app.post("/api/pipeline/report", async (c) => {
  c.header("X-Accel-Buffering", "no");
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runReportPipeline(signal)) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
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

  const server = createServer(getRequestListener(app.fetch));

  const wss = new WebSocketServer({ server, path: "/ws/voice" });

  wss.on("connection", (clientWs: WebSocket) => {
    console.log("Voice client connected");
    createVoiceProxy(clientWs, (event) => {
      const t = event.type as string;
      if (t === "session.ready") console.log("Voice session ready");
      if (t === "error") console.error("Voice error:", event.message);
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Ravendr server listening on 0.0.0.0:${PORT}`);
  });
}

start().catch(console.error);
