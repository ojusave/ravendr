import { task } from "@renderinc/sdk/workflows";
import { WebSocket } from "ws";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { setSessionTopic, setSessionStatus } from "../db.js";
import { logger } from "../../shared/logger.js";
import { research } from "./research.js";
import type { PhaseEvent } from "../../shared/events.js";
import { getBriefing } from "../db.js";

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
    name: "start_research",
    description:
      "Kick off the research workflow for a topic. Returns an opening line you say RIGHT AWAY. Does not wait for results.",
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
  {
    type: "function" as const,
    name: "next_update",
    description:
      "Get the next backend progress event. Blocks up to ~30s for it. Returns { speak, next_action } — you MUST say the `speak` text and then do what `next_action` says. When next_action says 'stop', the briefing is inside `speak` — read it all.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a live voice narrator for a research demo. You are NOT conversational — you are narrating what the backend is doing, in real time, in your natural voice.

When the user gives you a topic:

STEP 1. Call start_research(topic=<user's exact words>).
STEP 2. The tool returns { speak, next_action }. Say the \`speak\` text OUT LOUD verbatim. Then do what \`next_action\` says — always "call next_update now".
STEP 3. Each next_update returns { speak, next_action }. Say the speak text OUT LOUD. Then do the next_action.
STEP 4. The loop ends when next_action is "stop" — at that point \`speak\` contains the final briefing. Read the whole briefing aloud. Then stop.

HARD RULES:
- EVERY tool return has a \`speak\` field. You MUST say it, verbatim, in your voice. You are not paraphrasing or answering questions — you are the narrator reading a script.
- EVERY tool return has a \`next_action\` field. You MUST do it immediately after speaking.
- NEVER call two tools in a row without speaking in between.
- NEVER stop the loop before next_action says "stop".
- NEVER ask the user questions mid-research.`;

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

interface NarrationPayload {
  speak: string;
  next_action: string;
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

    // ── Narration queue for the polling-loop tool ───────────────────────
    const narrationQueue: NarrationPayload[] = [];
    const narrationWaiters: Array<(n: NarrationPayload) => void> = [];
    let totalBranches = 0;
    let seenBranches = 0;
    const phaseSubscriptions: Array<() => void> = [];
    let researchDispatched = false;

    function pushNarration(n: NarrationPayload): void {
      const w = narrationWaiters.shift();
      if (w) w(n);
      else narrationQueue.push(n);
    }

    function classify(e: PhaseEvent): NarrationPayload | null {
      switch (e.kind) {
        case "workflow.started":
          return {
            speak:
              "Render's workflow runner just picked up the job — spinning up now.",
            next_action: "call next_update now",
          };
        case "plan.ready": {
          totalBranches = e.queries.length;
          const angles = e.queries.map((q) => q.angle);
          return {
            speak: `Mastra's agent planned ${e.queries.length} parallel queries — covering ${formatList(angles)}. Firing them off to You.com now.`,
            next_action: "call next_update now",
          };
        }
        case "youcom.call.completed":
          seenBranches += 1;
          return {
            speak: `A You.com ${e.tier} call came back with ${e.sourceCount} sources in ${Math.round(e.latencyMs / 1000)} seconds. That's ${seenBranches} of ${totalBranches || "several"} done.`,
            next_action: "call next_update now",
          };
        case "agent.synthesizing":
          return {
            speak:
              "All the You.com calls are in. Mastra's agent is weaving the briefing together now — one moment.",
            next_action: "call next_update now",
          };
        case "workflow.failed":
          return {
            speak: `Something went wrong — ${e.message.slice(0, 120)}.`,
            next_action: "stop",
          };
        default:
          return null;
      }
    }

    async function subscribeAndDispatch(topic: string): Promise<void> {
      await setSessionTopic(config.DATABASE_URL, sessionId, topic);
      await setSessionStatus(config.DATABASE_URL, sessionId, "researching");
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "session.started",
        topic,
      });

      phaseSubscriptions.push(events.subscribe(sessionId, (e) => {
        if (e.kind === "briefing.ready") {
          getBriefing(config.DATABASE_URL, e.briefingId)
            .then((b) => {
              const content =
                b?.content ??
                "The briefing finished but the content didn't come through.";
              pushNarration({
                speak: content,
                next_action: "stop",
              });
            })
            .catch(() => {
              pushNarration({
                speak: "Couldn't load the finished briefing.",
                next_action: "stop",
              });
            });
          return;
        }
        const n = classify(e);
        if (n) pushNarration(n);
      }));

      // Fire the research subtask in the background; its events flow through
      // the subscription above. We do NOT await — next_update is what streams
      // narration back to the voice agent.
      (async () => {
        try {
          await research(sessionId, topic);
        } catch (err) {
          logger.error({ err, sessionId }, "research subtask failed");
          pushNarration({
            speak: "The research workflow hit an issue. Please try again.",
            next_action: "stop",
          });
        }
      })();
    }

    async function nextNarration(): Promise<NarrationPayload> {
      const queued = narrationQueue.shift();
      if (queued) return queued;
      return new Promise<NarrationPayload>((resolve) => {
        narrationWaiters.push(resolve);
      });
    }

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
        case "tool.call": {
          const callId = String(event.call_id ?? "");
          const name = String(event.name ?? "");
          const args =
            (event.args as Record<string, unknown> | undefined) ?? {};

          (async () => {
            let reply: NarrationPayload;
            if (name === "start_research") {
              const topic = String(args.topic ?? "").trim();
              if (!topic) {
                reply = {
                  speak: "I didn't catch the topic — can you say it again?",
                  next_action: "stop",
                };
              } else if (researchDispatched) {
                reply = {
                  speak: "Research is already running — hold on.",
                  next_action: "call next_update now",
                };
              } else {
                researchDispatched = true;
                try {
                  await subscribeAndDispatch(topic);
                  reply = {
                    speak: `Okay — researching ${topic}. Render's workflow is dispatched and I'll narrate every step as it happens.`,
                    next_action: "call next_update now",
                  };
                } catch (err) {
                  logger.error(
                    { err, sessionId, topic },
                    "start_research failed"
                  );
                  reply = {
                    speak:
                      "I hit an issue kicking off the workflow. Please try again.",
                    next_action: "stop",
                  };
                }
              }
            } else if (name === "next_update") {
              reply = await nextNarration();
            } else {
              logger.warn({ name }, "unknown tool call");
              reply = { speak: "Unknown tool.", next_action: "stop" };
            }
            assemblyWS.send(
              JSON.stringify({
                type: "tool.result",
                call_id: callId,
                result: JSON.stringify(reply),
              })
            );
          })().catch((err) => {
            logger.error({ err, sessionId }, "tool.call handler failed");
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
