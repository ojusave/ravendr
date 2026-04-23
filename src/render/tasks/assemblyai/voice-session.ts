import { task } from "@renderinc/sdk/workflows";
import { WebSocket } from "ws";
import { loadWorkflowConfig } from "../../../config.js";
import { createPostgresEventBus } from "../../event-bus.js";
import { setSessionTopic, setSessionStatus, getBriefing } from "../../db.js";
import { logger } from "../../../shared/logger.js";
import type { PhaseEvent } from "../../../shared/events.js";
import {
  openVoiceAgent,
  type BrowserOutgoing,
} from "../../../assemblyai/voice-agent.js";
import { research } from "../research.js";

/**
 * Root Render Workflow task: owns a voice session end-to-end.
 *
 *   Browser ←audio WS→ Web service (broker) ←reverse WS→ voiceSession
 *                                                             ↕
 *                                                    AssemblyAI voice-agent.ts
 *
 * This file is glue. The AssemblyAI WS protocol lives in
 * src/assemblyai/voice-agent.ts; the research pipeline lives in sibling
 * tasks. When tool.call fires, we block on the research subtask and
 * return the full briefing as tool.result.
 */

const TOOLS = [
  {
    type: "function" as const,
    name: "research",
    description:
      "Research a topic end-to-end. BLOCKS for up to a few minutes. Returns the full spoken briefing — read it aloud in full, verbatim.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The user's topic, verbatim." },
      },
      required: ["topic"],
    },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a voice-first research assistant.

When the user speaks a topic, call the \`research\` tool with their exact words. The tool takes about a minute — that is normal. Wait. When it returns, READ THE RETURNED TEXT OUT LOUD TO THE USER, word for word, in your natural voice. The returned text IS your spoken answer. After you finish reading it, stop. Do not paraphrase, do not shorten, do not add commentary, do not ask follow-ups.`;

const GREETING = "Hi — tell me any topic and I'll research it.";

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

    if (!publicWebUrl) throw new Error("publicWebUrl not provided");
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

    // ── open reverse WS back to the web-service broker ──────────────
    const reverseUrl = `${publicWebUrl.replace(/^http/, "ws")}/ws/task?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(taskToken)}`;
    logger.info({ reverseUrl }, "voiceSession: connecting reverse WS");
    const browserWS = new WebSocket(reverseUrl);
    await new Promise<void>((resolve, reject) => {
      browserWS.once("open", () => resolve());
      browserWS.once("error", (err) => reject(err));
    });

    const phaseSubscriptions: Array<() => void> = [];
    let researchPromise: Promise<string> | null = null;
    const done = new Promise<void>((resolve) => {
      const closeOnce = () => resolve();
      browserWS.once("close", closeOnce);
      browserWS.once("error", closeOnce);
    });

    // ── open AssemblyAI voice agent ─────────────────────────────────
    const agent = await openVoiceAgent({
      sessionId,
      apiKey: assemblyKey,
      agentUrl: assemblyAgentUrl,
      voice,
      systemPrompt: SYSTEM_PROMPT,
      greeting: GREETING,
      tools: TOOLS,
      onBrowserMessage: (msg: BrowserOutgoing) => sendBrowser(browserWS, msg),
      onClose: () => {
        try { browserWS.close(); } catch { /* noop */ }
      },
      onToolCall: async ({ name, args }) => {
        if (name !== "research") return "Unknown tool.";
        const topic = String(args.topic ?? "").trim();
        if (!topic) return "I didn't catch the topic — can you say it again?";

        if (!researchPromise) {
          researchPromise = runResearch(
            topic,
            sessionId,
            config.DATABASE_URL,
            events,
            phaseSubscriptions
          );
        }
        try {
          return await researchPromise;
        } catch (err) {
          logger.error({ err, sessionId, topic }, "research failed");
          return "I hit an issue running the research. Please try again.";
        }
      },
    });

    // ── forward mic audio browser → AssemblyAI ──────────────────────
    browserWS.on("message", (raw) => {
      const msg = parseJson<{ type?: string; audio?: string }>(raw);
      if (msg?.type === "audio" && typeof msg.audio === "string") {
        agent.sendUserAudio(msg.audio);
      }
    });

    try {
      await done;
    } finally {
      for (const dispose of phaseSubscriptions) {
        try { dispose(); } catch { /* noop */ }
      }
      agent.close();
      await events.stop();
    }
    logger.info({ sessionId }, "voiceSession: closed");
    return { status: "closed" };
  }
);

/**
 * Kicks off the research subtask tree, subscribes to phase events, waits
 * for briefing.ready, fetches the briefing, returns the text for AssemblyAI
 * to read aloud.
 */
async function runResearch(
  topic: string,
  sessionId: string,
  databaseUrl: string,
  events: Awaited<ReturnType<typeof createPostgresEventBus>>,
  phaseSubscriptions: Array<() => void>
): Promise<string> {
  logger.info({ sessionId, topic }, "runResearch: start");

  await setSessionTopic(databaseUrl, sessionId, topic);
  await setSessionStatus(databaseUrl, sessionId, "researching");
  await events.publish({
    sessionId,
    at: Date.now(),
    kind: "session.started",
    topic,
  });

  const briefingReady = new Promise<{ briefingId: string }>(
    (resolve, reject) => {
      const dispose = events.subscribe(sessionId, (e: PhaseEvent) => {
        if (e.kind === "briefing.ready") resolve({ briefingId: e.briefingId });
        else if (e.kind === "workflow.failed")
          reject(new Error(e.message || "workflow failed"));
      });
      phaseSubscriptions.push(dispose);
    }
  );

  // Fire research subtask in background. If dispatch throws before the
  // child emits workflow.failed, publish it ourselves so briefingReady
  // can reject and the tool handler doesn't hang.
  (async () => {
    try {
      await research(sessionId, topic);
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
  const briefing = await getBriefing(databaseUrl, briefingId);
  return (
    briefing?.content ??
    "The briefing finished but the content didn't come through."
  );
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
