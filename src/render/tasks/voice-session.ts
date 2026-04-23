import { task } from "@renderinc/sdk/workflows";
import { WebSocket } from "ws";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { setSessionTopic, setSessionStatus } from "../db.js";
import { logger } from "../../shared/logger.js";
import { research, type ResearchResult } from "./research.js";

/**
 * Root Render Workflow task: owns a voice session end-to-end.
 *
 * Architecture:
 *   Browser ←audio WS→ Web service (pure broker) ←reverse WS→ voiceSession task
 *                                                                  ↕
 *                                                            AssemblyAI Voice Agent
 *
 * This task:
 *   1. Opens a reverse WebSocket back to the web service (audio tunnel).
 *   2. Opens a WebSocket to AssemblyAI (acts as the "server-side proxy"
 *      that AssemblyAI's docs require).
 *   3. Pipes mic audio browser→AssemblyAI and agent audio AssemblyAI→browser.
 *   4. On AssemblyAI tool.call "research(topic)", dispatches the research
 *      subtask (which itself fans out into plan/search/synthesize subtasks),
 *      awaits the briefing, returns it as tool.result.
 *
 * Every meaningful step is its own Render task run, independently retried.
 */

const TOOLS = [
  {
    type: "function" as const,
    name: "research",
    description:
      "Research a topic end-to-end. Blocks for about a minute while Render dispatches a Mastra + You.com workflow. Returns the spoken briefing text — read it aloud verbatim.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The user's topic, verbatim.",
        },
      },
      required: ["topic"],
    },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a voice research host.

When the user gives you any topic, call the \`research\` tool with their exact words. The tool takes about a minute to return; that's expected. When it returns, read the full briefing text aloud, verbatim, in your natural voice. Do not paraphrase, summarize, or shorten. Do not add commentary before or after. After speaking the briefing, stop.`;

const GREETING =
  "Hi — tell me any topic and I'll research it live. You'll see the stack working on screen while I dig in, then I'll read you what I found.";

interface BrowserMessage {
  type: string;
  audio?: string;
}

interface AssemblyEvent {
  type?: string;
  [key: string]: unknown;
}

export const voiceSession = task(
  {
    name: "voiceSession",
    plan: "starter",
    timeoutSeconds: 3600, // 1 hour — a single research session never runs this long
    retry: { maxRetries: 0, waitDurationMs: 1_000, backoffScaling: 1 },
  },
  async function voiceSession(
    sessionId: string,
    taskToken: string,
    publicWebUrl: string
  ): Promise<{ status: "closed" }> {
    logger.info({ sessionId, publicWebUrl }, "voiceSession: start");
    const config = loadWorkflowConfig();

    const webUrl = publicWebUrl;
    if (!webUrl) throw new Error("publicWebUrl not provided by dispatcher");
    const assemblyKey = process.env.ASSEMBLYAI_API_KEY;
    if (!assemblyKey) throw new Error("ASSEMBLYAI_API_KEY not set");
    const assemblyAgentUrl =
      process.env.ASSEMBLYAI_AGENT_URL ??
      "wss://agents.assemblyai.com/v1/realtime";
    const voice = process.env.ASSEMBLYAI_VOICE ?? "claire";

    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    // ── open reverse WS to web service ─────────────────────────────────
    const reverseUrl = `${webUrl.replace(
      /^http/,
      "ws"
    )}/ws/task?sessionId=${encodeURIComponent(
      sessionId
    )}&token=${encodeURIComponent(taskToken)}`;
    logger.info({ reverseUrl }, "voiceSession: connecting reverse WS");
    const browserWS = new WebSocket(reverseUrl);

    // ── open AssemblyAI WS ─────────────────────────────────────────────
    logger.info({ url: assemblyAgentUrl }, "voiceSession: opening AssemblyAI");
    const assemblyWS = new WebSocket(assemblyAgentUrl, {
      headers: { authorization: `Bearer ${assemblyKey}` },
    });

    const done = new Promise<void>((resolve) => {
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try {
          browserWS.close();
        } catch {
          /* noop */
        }
        try {
          assemblyWS.close();
        } catch {
          /* noop */
        }
        resolve();
      };
      browserWS.once("close", closeOnce);
      browserWS.once("error", closeOnce);
      assemblyWS.once("close", closeOnce);
      assemblyWS.once("error", closeOnce);
    });

    // Wait for both peers to open.
    await Promise.all([
      waitForOpen(browserWS, "browser-reverse"),
      waitForOpen(assemblyWS, "assemblyai"),
    ]);

    // ── configure AssemblyAI session ───────────────────────────────────
    assemblyWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          system_prompt: SYSTEM_PROMPT,
          output: { voice },
          greeting: GREETING,
          tools: TOOLS,
        },
      })
    );

    // Tell the browser we're live.
    sendBrowser(browserWS, { type: "ready" });

    // ── browser → AssemblyAI: mic audio ────────────────────────────────
    browserWS.on("message", (raw) => {
      const msg = parseJson<BrowserMessage>(raw);
      if (!msg) return;
      if (msg.type === "audio" && typeof msg.audio === "string") {
        if (assemblyWS.readyState === WebSocket.OPEN) {
          assemblyWS.send(
            JSON.stringify({ type: "input.audio", audio: msg.audio })
          );
        }
      }
    });

    // ── AssemblyAI → browser: agent audio, transcripts, tool.call ──────
    assemblyWS.on("message", async (raw: Buffer) => {
      const event = parseJson<AssemblyEvent>(raw);
      if (!event) return;
      switch (event.type) {
        case "reply.audio": {
          const data = event.data;
          if (typeof data === "string") {
            sendBrowser(browserWS, { type: "audio", audio: data });
          }
          break;
        }
        case "transcript.user.delta":
          sendBrowser(browserWS, {
            type: "transcript",
            role: "user",
            text: String(event.text ?? ""),
            final: false,
          });
          break;
        case "transcript.user":
          sendBrowser(browserWS, {
            type: "transcript",
            role: "user",
            text: String(event.text ?? ""),
            final: true,
          });
          break;
        case "transcript.agent":
          sendBrowser(browserWS, {
            type: "transcript",
            role: "assistant",
            text: String(event.text ?? ""),
            final: true,
          });
          break;
        case "tool.call":
          handleToolCall(
            assemblyWS,
            event,
            sessionId,
            events,
            config.DATABASE_URL
          ).catch((err) => {
            logger.error({ err, sessionId }, "tool.call handler failed");
          });
          break;
        case "session.error":
        case "error":
          logger.warn(
            { sessionId, code: event.code, message: event.message },
            "AssemblyAI error"
          );
          sendBrowser(browserWS, {
            type: "error",
            message: `${event.code ?? ""}: ${event.message ?? "unknown"}`,
          });
          break;
      }
    });

    try {
      await done;
    } finally {
      await events.stop();
    }
    logger.info({ sessionId }, "voiceSession: closed");
    return { status: "closed" };
  }
);

async function handleToolCall(
  assemblyWS: WebSocket,
  event: AssemblyEvent,
  sessionId: string,
  events: Awaited<ReturnType<typeof createPostgresEventBus>>,
  databaseUrl: string
): Promise<void> {
  const callId = String(event.call_id ?? "");
  const name = String(event.name ?? "");
  const args = (event.args as Record<string, unknown> | undefined) ?? {};

  if (name !== "research") {
    logger.warn({ name }, "unknown tool call");
    assemblyWS.send(
      JSON.stringify({
        type: "tool.result",
        call_id: callId,
        result: JSON.stringify("Unknown tool."),
      })
    );
    return;
  }

  const topic = String(args.topic ?? "").trim();
  if (!topic) {
    assemblyWS.send(
      JSON.stringify({
        type: "tool.result",
        call_id: callId,
        result: JSON.stringify(
          "I didn't catch the topic — can you say it again?"
        ),
      })
    );
    return;
  }

  try {
    await setSessionTopic(databaseUrl, sessionId, topic);
    await setSessionStatus(databaseUrl, sessionId, "researching");
    await events.publish({
      sessionId,
      at: Date.now(),
      kind: "session.started",
      topic,
    });

    // Dispatch the research subtask. Each `await` inside `research` is
    // itself a subtask dispatch — that's where per-step checkpointing lives.
    const result: ResearchResult = await research(sessionId, topic);

    assemblyWS.send(
      JSON.stringify({
        type: "tool.result",
        call_id: callId,
        result: JSON.stringify(result.content),
      })
    );
  } catch (err) {
    logger.error({ err, sessionId, topic }, "research subtask failed");
    assemblyWS.send(
      JSON.stringify({
        type: "tool.result",
        call_id: callId,
        result: JSON.stringify(
          "I hit an issue running the research workflow. Please try again."
        ),
      })
    );
  }
}

function waitForOpen(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      logger.info({ label }, "WS opened");
      resolve();
    });
    ws.once("error", (err) => {
      reject(new Error(`${label} WS error: ${(err as Error).message}`));
    });
    ws.once("close", (code, reason) => {
      reject(
        new Error(
          `${label} WS closed before open (code=${code} reason=${reason?.toString()})`
        )
      );
    });
  });
}

function sendBrowser(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* swallow */
  }
}

function parseJson<T>(raw: unknown): T | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
