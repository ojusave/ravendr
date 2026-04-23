import { task } from "@renderinc/sdk/workflows";
import { WebSocket } from "ws";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import {
  setSessionTopic,
  setSessionStatus,
  getBriefing,
} from "../db.js";
import { logger } from "../../shared/logger.js";
import { research } from "./research.js";
import type { PhaseEvent } from "../../shared/events.js";

/**
 * Root Render Workflow task: owns a voice session end-to-end.
 *
 *   Browser ←audio WS→ Web service (broker) ←reverse WS→ voiceSession task
 *                                                             ↕
 *                                                       AssemblyAI Voice Agent
 *
 * Single blocking `research` tool. The AssemblyAI LLM does not reliably
 * loop polling-style tool calls, so we collapse the pipeline into one
 * tool.result that carries a full narration + the briefing. The agent
 * calls research(topic), waits (~60-90s), then reads the entire return
 * aloud. Visual activity feed carries real-time progress during the wait.
 */

const TOOLS = [
  {
    type: "function" as const,
    name: "research",
    description:
      "Research a topic end-to-end. BLOCKS for up to a few minutes while Render dispatches a Mastra+You.com workflow. Returns the full spoken narration including the briefing — read it aloud in full, verbatim, in your natural voice.",
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

const SYSTEM_PROMPT = `You are Ravendr, a voice-first research assistant.

The user will speak a topic. Call the \`research\` tool with their exact words. The tool takes about a minute — that is normal. Wait. When it returns, READ THE RETURNED TEXT OUT LOUD TO THE USER, word for word, in your natural voice. The returned text IS your spoken answer. After you finish reading it, stop. Do not paraphrase, do not shorten, do not add commentary, do not ask follow-ups.`;

const GREETING =
  "Hi — tell me any topic and I'll research it live. Watch the stack work on screen while I dig in, then I'll read you what I found.";

interface AssemblyEvent {
  type?: string;
  [key: string]: unknown;
}

function formatList(items: string[]): string {
  if (items.length === 0) return "a few angles";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

export const voiceSession = task(
  {
    name: "voiceSession",
    plan: "starter",
    timeoutSeconds: 3600,
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

    // ── open reverse WS to web service ────────────────────────────────
    const reverseUrl = `${webUrl.replace(
      /^http/,
      "ws"
    )}/ws/task?sessionId=${encodeURIComponent(
      sessionId
    )}&token=${encodeURIComponent(taskToken)}`;
    logger.info({ reverseUrl }, "voiceSession: connecting reverse WS");
    const browserWS = new WebSocket(reverseUrl);

    // ── open AssemblyAI WS ────────────────────────────────────────────
    logger.info({ url: assemblyAgentUrl }, "voiceSession: opening AssemblyAI");
    const assemblyWS = new WebSocket(assemblyAgentUrl, {
      headers: { authorization: `Bearer ${assemblyKey}` },
    });

    const phaseSubscriptions: Array<() => void> = [];
    let researchPromise: Promise<string> | null = null;

    const done = new Promise<void>((resolve) => {
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try { browserWS.close(); } catch { /* noop */ }
        try { assemblyWS.close(); } catch { /* noop */ }
        resolve();
      };
      browserWS.once("close", closeOnce);
      browserWS.once("error", closeOnce);
      assemblyWS.once("close", closeOnce);
      assemblyWS.once("error", closeOnce);
    });

    await Promise.all([
      waitForOpen(browserWS, "browser-reverse"),
      waitForOpen(assemblyWS, "assemblyai"),
    ]);

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

    sendBrowser(browserWS, { type: "ready" });

    // ── browser → AssemblyAI: mic audio ──────────────────────────────
    browserWS.on("message", (raw) => {
      const msg = parseJson<{ type?: string; audio?: string }>(raw);
      if (!msg) return;
      if (msg.type === "audio" && typeof msg.audio === "string") {
        if (assemblyWS.readyState === WebSocket.OPEN) {
          assemblyWS.send(
            JSON.stringify({ type: "input.audio", audio: msg.audio })
          );
        }
      }
    });

    // ── AssemblyAI → browser: agent audio, transcripts, tool.call ────
    let upstreamMessageCount = 0;
    assemblyWS.on("message", async (raw: Buffer) => {
      const event = parseJson<AssemblyEvent>(raw);
      if (!event) return;
      // Skip reply.audio in logs — it spams. Log everything else to make
      // voice failures legible.
      if (event.type !== "reply.audio" && upstreamMessageCount < 80) {
        logger.info(
          { sessionId, type: event.type, keys: Object.keys(event).slice(0, 6) },
          "AssemblyAI event"
        );
        upstreamMessageCount++;
      }
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
          logger.info(
            { sessionId, text: String(event.text ?? "").slice(0, 120) },
            "transcript.user (final)"
          );
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
        case "tool.call": {
          const callId = String(event.call_id ?? "");
          const name = String(event.name ?? "");
          const args =
            (event.args as Record<string, unknown> | undefined) ?? {};
          logger.info(
            { sessionId, callId, name, args },
            "AssemblyAI tool.call"
          );
          if (name !== "research") {
            assemblyWS.send(
              JSON.stringify({
                type: "tool.result",
                call_id: callId,
                result: JSON.stringify("Unknown tool."),
              })
            );
            break;
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
            break;
          }

          // Memoize: multiple tool.call for the same topic share the same
          // run. The second caller gets the same final narration.
          if (!researchPromise) {
            researchPromise = runResearch(
              topic,
              sessionId,
              config.DATABASE_URL,
              events,
              phaseSubscriptions
            );
          }
          researchPromise
            .then((narration) => {
              logger.info(
                { sessionId, callId, narrationLen: narration.length },
                "sending tool.result (success)"
              );
              assemblyWS.send(
                JSON.stringify({
                  type: "tool.result",
                  call_id: callId,
                  result: JSON.stringify(narration),
                })
              );
            })
            .catch((err) => {
              logger.error({ err, sessionId, topic }, "research failed");
              logger.info(
                { sessionId, callId },
                "sending tool.result (error)"
              );
              assemblyWS.send(
                JSON.stringify({
                  type: "tool.result",
                  call_id: callId,
                  result: JSON.stringify(
                    "I hit an issue running the research. Please try again."
                  ),
                })
              );
            });
          break;
        }
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
      for (const dispose of phaseSubscriptions) {
        try { dispose(); } catch { /* noop */ }
      }
      await events.stop();
    }
    logger.info({ sessionId }, "voiceSession: closed");
    return { status: "closed" };
  }
);

/**
 * Dispatches the research subtask, watches phase events, and — when
 * briefing.ready fires — composes a single rich narration containing
 * what each platform did plus the full briefing text.
 */
async function runResearch(
  topic: string,
  sessionId: string,
  databaseUrl: string,
  events: Awaited<ReturnType<typeof createPostgresEventBus>>,
  phaseSubscriptions: Array<() => void>
): Promise<string> {
  const summary = {
    plannedCount: 0,
    angles: [] as string[],
    branchesComplete: 0,
    totalSources: 0,
  };

  await setSessionTopic(databaseUrl, sessionId, topic);
  await setSessionStatus(databaseUrl, sessionId, "researching");
  await events.publish({
    sessionId,
    at: Date.now(),
    kind: "session.started",
    topic,
  });

  logger.info({ sessionId, topic }, "runResearch: subscribing + dispatching");

  const briefingReady = new Promise<{ briefingId: string }>(
    (resolve, reject) => {
      const dispose = events.subscribe(sessionId, (e: PhaseEvent) => {
        logger.info({ sessionId, kind: e.kind }, "phase event");
        switch (e.kind) {
          case "plan.ready":
            summary.plannedCount = e.queries.length;
            summary.angles = e.queries.map((q) => q.angle);
            break;
          case "youcom.call.completed":
            summary.branchesComplete += 1;
            summary.totalSources += e.sourceCount;
            break;
          case "briefing.ready":
            resolve({ briefingId: e.briefingId });
            break;
          case "workflow.failed":
            reject(new Error(e.message || "workflow failed"));
            break;
        }
      });
      phaseSubscriptions.push(dispose);
    }
  );

  // Fire research subtask in background. If it throws BEFORE emitting
  // workflow.failed (e.g., SDK fails to dispatch), we publish workflow.failed
  // ourselves so briefingReady can reject and the voice handler doesn't hang.
  (async () => {
    try {
      logger.info({ sessionId }, "runResearch: dispatching research subtask");
      await research(sessionId, topic);
      logger.info({ sessionId }, "runResearch: research subtask returned");
    } catch (err) {
      logger.error({ err, sessionId }, "research subtask failed");
      await events
        .publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.failed",
          runId: process.env.RENDER_TASK_RUN_ID ?? "unknown",
          message: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
    }
  })();

  const { briefingId } = await briefingReady;
  logger.info({ sessionId, briefingId }, "runResearch: briefingReady");
  const briefing = await getBriefing(databaseUrl, briefingId);
  const body =
    briefing?.content ??
    "The briefing finished but the content didn't come through.";

  // Return JUST the briefing text. AssemblyAI's model reads the
  // returned string as its spoken reply. A prefixed narration made
  // the model paraphrase or skip; raw content is more reliably read.
  void summary;
  return body;
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
