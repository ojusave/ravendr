import type { WebSocket as BrowserWS } from "ws";
import type {
  VoiceRuntime,
  VoiceSession,
  VoiceToolDef,
  EventBus,
} from "../shared/ports.js";
import type { WorkflowDispatcher } from "../render/workflow-dispatcher.js";
import type { PhaseEvent } from "../shared/events.js";
import {
  setSessionTopic,
  setSessionStatus,
  getBriefing,
} from "../render/db.js";
import { logger } from "../shared/logger.js";

/**
 * Bridges a browser WebSocket to an AssemblyAI VoiceSession.
 *
 * Voice architecture — polling loop for live narration:
 *
 *   The AssemblyAI Voice Agent has no server-push speech primitive. Tool
 *   returns are context the LLM uses to generate a spoken reply. So we give
 *   the agent TWO tools and tell it to loop:
 *
 *     research_start(topic)  — kicks off the Mastra Agent inside a Render
 *                              Workflow task. Returns the first narration.
 *     next_update()          — blocks up to 30 s for the next phase event
 *                              pushed by the backend. Returns structured data
 *                              with a `narrate` hint. Returns {done:true,
 *                              briefing} when the run is finished.
 *
 *   The agent's system prompt tells it to keep calling next_update after
 *   each narration until done. That turns backend phase events into a live
 *   voice commentary track — one consistent AssemblyAI voice, no silence.
 */

export interface WireOpts {
  browser: BrowserWS;
  sessionId: string;
  voice: VoiceRuntime;
  events: EventBus;
  dispatcher: WorkflowDispatcher;
  databaseUrl: string;
}

const TOOLS: VoiceToolDef[] = [
  {
    type: "function",
    name: "research_start",
    description:
      "Start the research workflow for a topic. Returns an opening line under `narrate` to say to the user, and a hint to call next_update repeatedly for progress.",
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
    type: "function",
    name: "next_update",
    description:
      "Block up to 30 seconds for the next backend progress event. Returns { narrate, ... } describing what just happened, or { done: true, briefing } when the briefing is ready. KEEP CALLING THIS UNTIL done:true.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a voice research host. You narrate live what the backend is doing while it researches a topic.

When the user gives you a topic, follow this loop:

1. Call research_start(topic="<the user's exact words>"). The result has a \`narrate\` field — say that to the user in first person, in your own voice. This kicks off Render's workflow and Mastra's agent.

2. Call next_update(). Each response has a \`narrate\` field describing what just happened in the backend (Mastra planned queries, a You.com call came back, etc). Say the narrate text to the user naturally — do NOT read the JSON, do NOT paraphrase beyond style, just speak about what happened. Then call next_update() again.

3. Keep looping. Do NOT stop early. Do NOT skip calling next_update after speaking. The loop is what makes the voice live.

4. When next_update returns { done: true, briefing }, read the briefing aloud in full. Then stop — don't call next_update again.

Rules:
- Always speak between tool calls. Never call two tools back-to-back without saying something.
- Don't ask the user follow-up questions. Don't apologize. Don't summarize what you're about to do. Just narrate what's happening.
- If next_update returns { phase: "heartbeat" }, say something brief and casual ("still working…") and call next_update again.
- If next_update returns { phase: "error" }, tell the user what failed and stop.`;

const GREETING =
  "Hi — tell me any topic and I'll research it live. I'll narrate the stack working as it goes, then read you the briefing when it's done.";

interface NarrationPayload {
  phase:
    | "started"
    | "planned"
    | "search_progress"
    | "synthesizing"
    | "done"
    | "error"
    | "heartbeat";
  narrate: string;
  [key: string]: unknown;
}

const HEARTBEAT_MS = 30_000;

export async function wireVoiceSession(opts: WireOpts): Promise<void> {
  const { browser, sessionId, voice, events, dispatcher, databaseUrl } = opts;

  let session: VoiceSession | null = null;
  const abort = new AbortController();

  // ── Narration queue and one-shot dispatch state ──────────────────────
  const queue: NarrationPayload[] = [];
  const waiters: Array<(n: NarrationPayload) => void> = [];
  let dispatched = false;
  let unsubscribe: (() => void) | null = null;
  let seenBranches = 0;
  let totalBranches = 0;

  function push(n: NarrationPayload): void {
    const waiter = waiters.shift();
    if (waiter) waiter(n);
    else queue.push(n);
  }

  function nextNarration(): Promise<NarrationPayload> {
    return new Promise((resolve) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);

      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onPush);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve({
          phase: "heartbeat",
          narrate: "Still working — just give it a moment.",
        });
      }, HEARTBEAT_MS);

      const onPush = (n: NarrationPayload) => {
        clearTimeout(timer);
        resolve(n);
      };
      waiters.push(onPush);
    });
  }

  function classify(e: PhaseEvent): NarrationPayload | null {
    switch (e.kind) {
      case "workflow.started":
        return {
          phase: "started",
          narrate:
            "Render's workflow runner just picked up the job — the Mastra agent is starting up inside it.",
        };
      case "plan.ready": {
        totalBranches = e.queries.length;
        const angles = e.queries.map((q) => q.angle);
        return {
          phase: "planned",
          queries_count: e.queries.length,
          angles,
          narrate: `Mastra's agent planned ${e.queries.length} parallel queries — covering ${formatList(angles)}. Firing them off to You.com now.`,
        };
      }
      case "youcom.call.completed":
        seenBranches += 1;
        return {
          phase: "search_progress",
          completed: seenBranches,
          total: totalBranches,
          new_sources: e.sourceCount,
          latency_ms: e.latencyMs,
          tier: e.tier,
          narrate: `A You.com ${e.tier} call just came back — ${e.sourceCount} sources in ${Math.round(e.latencyMs / 1000)} seconds. That's ${seenBranches} of ${totalBranches || "?"} done.`,
        };
      case "agent.synthesizing":
        return {
          phase: "synthesizing",
          narrate:
            "All the You.com calls are in. Mastra's agent is weaving the briefing together now — one moment.",
        };
      case "workflow.failed":
        return {
          phase: "error",
          message: e.message,
          narrate: `Something went wrong — the workflow failed with: ${e.message.slice(0, 120)}.`,
        };
      default:
        return null;
    }
  }

  async function research_start(rawTopic: string): Promise<NarrationPayload> {
    const topic = rawTopic.trim();
    if (!topic) {
      return {
        phase: "error",
        narrate: "I didn't catch a topic — can you say it again?",
      };
    }
    if (dispatched) {
      return {
        phase: "started",
        narrate:
          "Already researching — give it a second and I'll tell you what's happening.",
      };
    }
    dispatched = true;

    try {
      await setSessionTopic(databaseUrl, sessionId, topic);
      await setSessionStatus(databaseUrl, sessionId, "researching");
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "session.started",
        topic,
      });

      // Subscribe BEFORE dispatching so we don't miss early events.
      unsubscribe = events.subscribe(sessionId, (e) => {
        if (e.kind === "briefing.ready") {
          // Resolve with the full briefing text so the model reads it.
          getBriefing(databaseUrl, e.briefingId)
            .then((b) => {
              push({
                phase: "done",
                briefing:
                  b?.content ??
                  "The briefing finished but the content didn't come through.",
                narrate: b?.content ?? "Here's what I found.",
              });
            })
            .catch(() => {
              push({
                phase: "error",
                narrate: "Couldn't load the finished briefing.",
              });
            });
          return;
        }
        const n = classify(e);
        if (n) push(n);
      });

      const runId = await dispatcher.dispatchResearch({ sessionId, topic });
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.dispatched",
        runId,
      });

      return {
        phase: "started",
        topic,
        run_id: runId,
        narrate: `Okay — researching ${topic}. I just dispatched a Render workflow for this. I'll tell you each step as it happens.`,
      };
    } catch (err) {
      logger.error({ err, sessionId, topic }, "research_start failed");
      dispatched = false;
      return {
        phase: "error",
        narrate:
          "I hit an issue kicking off the workflow. Give it another try.",
      };
    }
  }

  try {
    session = await voice.openSession({
      sessionId,
      systemPrompt: SYSTEM_PROMPT,
      greeting: GREETING,
      tools: TOOLS,
      // Fallback: if the model doesn't call research_start on its own,
      // kick dispatch from the first final user transcript. The tool call
      // will then return the started narration as usual.
      onUserTurn: async (topic) => {
        const n = await research_start(topic);
        return JSON.stringify(n);
      },
      onToolCall: async (name, args) => {
        if (name === "research_start") {
          const n = await research_start(String(args.topic ?? ""));
          return JSON.stringify(n);
        }
        if (name === "next_update") {
          const n = await nextNarration();
          return JSON.stringify(n);
        }
        logger.warn({ name }, "unknown tool call");
        return JSON.stringify({ phase: "error", narrate: "Unknown tool." });
      },
      onEvent: (e) => {
        if (
          e.kind === "user.transcript.partial" ||
          e.kind === "user.transcript.final"
        ) {
          safeSend(browser, {
            type: "transcript",
            role: "user",
            text: e.text,
            final: e.kind === "user.transcript.final",
          });
          if (e.kind === "user.transcript.final" && e.text.trim() && !dispatched) {
            research_start(e.text.trim()).catch(() => {});
          }
        }
        if (e.kind === "agent.transcript") {
          safeSend(browser, {
            type: "transcript",
            role: "assistant",
            text: e.text,
            final: true,
          });
        }
        if (e.kind === "error") {
          logger.warn({ sessionId, message: e.message }, "voice upstream error");
          safeSend(browser, { type: "error", message: e.message });
        }
      },
      signal: abort.signal,
    });
  } catch (err) {
    logger.error({ err, sessionId }, "failed to open voice session");
    safeSend(browser, { type: "error", message: "voice unavailable" });
    browser.close();
    return;
  }

  session.onAgentAudio((chunk) => {
    safeSend(browser, {
      type: "audio",
      audio: Buffer.from(chunk).toString("base64"),
    });
  });

  browser.on("message", (raw) => {
    const msg = parseJson(raw);
    if (!msg) return;
    if (msg.type === "audio" && typeof msg.audio === "string") {
      try {
        session?.sendUserAudio(Buffer.from(msg.audio, "base64"));
      } catch (err) {
        logger.warn({ err, sessionId }, "sendUserAudio failed");
      }
    }
  });

  const cleanup = () => {
    abort.abort();
    unsubscribe?.();
    session?.close().catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);

  safeSend(browser, { type: "ready" });
}

function formatList(items: string[]): string {
  if (items.length === 0) return "a few angles";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

function safeSend(ws: BrowserWS, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* swallow — browser disconnected */
  }
}

function parseJson(raw: unknown): Record<string, any> | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
