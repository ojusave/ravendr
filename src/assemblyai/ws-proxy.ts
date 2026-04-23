import type { WebSocket as BrowserWS } from "ws";
import type {
  VoiceRuntime,
  VoiceSession,
  VoiceToolDef,
  EventBus,
} from "../shared/ports.js";
import type { WorkflowDispatcher } from "../render/workflow-dispatcher.js";
import {
  setSessionTopic,
  setSessionStatus,
  getBriefing,
} from "../render/db.js";
import { waitForEvent } from "../shared/wait-for-event.js";
import { logger } from "../shared/logger.js";

/**
 * Wires a browser WebSocket to an AssemblyAI VoiceSession.
 *
 * The agent is given FOUR tools it must call in order. Each returns a short
 * narration string it speaks aloud as the backend progresses:
 *
 *   start_research(topic)   → dispatches Render Workflow    → "Kicking off…"
 *   wait_for_plan()         → blocks on plan.ready          → "Mastra planned N queries…"
 *   wait_for_branches()     → blocks on all youcom.completed→ "All N calls back…"
 *   deliver_briefing()      → blocks on briefing.ready      → <full briefing>
 *
 * The system prompt is strict about calling all four, in order, with no
 * substitution. The chain-ribbon updates visually via SSE independently.
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
    name: "start_research",
    description:
      "STEP 1 of 4. Always call this first when the user gives any topic. Returns a short spoken acknowledgement. Must be followed by wait_for_plan.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The user's topic, verbatim." },
      },
      required: ["topic"],
    },
  },
  {
    type: "function",
    name: "wait_for_plan",
    description:
      "STEP 2 of 4. Always call after start_research. Blocks until Mastra's planner finishes. Returns a short spoken line describing the research plan. Must be followed by wait_for_branches.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "wait_for_branches",
    description:
      "STEP 3 of 4. Always call after wait_for_plan. Blocks until all parallel You.com research calls return. Returns a short spoken summary. Must be followed by deliver_briefing.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "deliver_briefing",
    description:
      "STEP 4 of 4. Always call last. Returns the full spoken briefing (may be long). This is the final spoken content — do not call any more tools after this.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a voice host for a live research demo.

When the user gives ANY topic — even a greeting, even small-talk — you run a
strict 4-step sequence. You never substitute your own content.

1. Call start_research with topic=<the user's words, verbatim>.
2. Speak the tool's return value verbatim.
3. IMMEDIATELY call wait_for_plan. Do NOT wait for new user input.
4. Speak its return value verbatim.
5. IMMEDIATELY call wait_for_branches.
6. Speak its return value verbatim.
7. IMMEDIATELY call deliver_briefing.
8. Speak its return value verbatim. This is the final briefing — stop here.

Never skip a step. Never reorder. Never add your own commentary. Chain all
four tool calls automatically — do not wait for the user between steps.`;

const GREETING = "Hi — tell me any topic and I'll narrate the whole stack as it researches it.";

export async function wireVoiceSession(opts: WireOpts): Promise<void> {
  const { browser, sessionId, voice, events, dispatcher, databaseUrl } = opts;

  let session: VoiceSession | null = null;
  const abort = new AbortController();

  // ── Per-session state for tool handlers ──────────────────────────────
  const state = {
    topic: null as string | null,
    runId: null as string | null,
    plannedCount: 0,
    branchesComplete: 0,
    briefingText: null as string | null,
  };

  // Memoize handler work — agent might retry or call out of order.
  let startResearchPromise: Promise<string> | null = null;
  let waitForPlanPromise: Promise<string> | null = null;
  let waitForBranchesPromise: Promise<string> | null = null;
  let deliverBriefingPromise: Promise<string> | null = null;

  async function startResearch(topic: string): Promise<string> {
    if (startResearchPromise) return startResearchPromise;
    startResearchPromise = (async () => {
      const clean = topic.trim();
      if (!clean) return "I didn't catch a topic — can you say it again?";
      state.topic = clean;
      try {
        await setSessionTopic(databaseUrl, sessionId, clean);
        await setSessionStatus(databaseUrl, sessionId, "researching");
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "session.started",
          topic: clean,
        });
        const runId = await dispatcher.dispatchResearch({ sessionId, topic: clean });
        state.runId = runId;
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.dispatched",
          runId,
        });
        return `Okay, researching ${clean}. I've kicked off a Render workflow — instance spinning up. Now calling Mastra to plan the angles.`;
      } catch (err) {
        logger.error({ err, sessionId, topic: clean }, "start_research failed");
        startResearchPromise = null;
        return "I hit an issue kicking off the workflow. Try again in a moment.";
      }
    })();
    return startResearchPromise;
  }

  async function waitForPlan(): Promise<string> {
    if (waitForPlanPromise) return waitForPlanPromise;
    waitForPlanPromise = (async () => {
      if (!state.topic) return "Call start_research first.";
      try {
        const ev = await waitForEvent({
          events,
          sessionId,
          kind: "plan.ready",
          timeoutMs: 60_000,
        });
        state.plannedCount = ev.queries.length;
        const angles = ev.queries.map((q) => q.angle).join(", ");
        return `Mastra's researcher drafted ${ev.queries.length} parallel queries — covering ${angles}. Now calling You.com for each.`;
      } catch (err) {
        logger.warn({ err, sessionId }, "wait_for_plan failed");
        waitForPlanPromise = null;
        return "The planner hit an issue. Let me try to keep going.";
      }
    })();
    return waitForPlanPromise;
  }

  async function waitForBranches(): Promise<string> {
    if (waitForBranchesPromise) return waitForBranchesPromise;
    waitForBranchesPromise = (async () => {
      const expected = state.plannedCount || 1;
      let totalSources = 0;
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(
            `Still waiting on some research branches — let me move on with what we have.`
          );
        }, 180_000);

        const unsubscribe = events.subscribe(sessionId, (e) => {
          if (e.kind === "youcom.call.completed") {
            state.branchesComplete += 1;
            totalSources += e.sourceCount;
            if (state.branchesComplete >= expected) {
              clearTimeout(timer);
              unsubscribe();
              resolve(
                `All ${state.branchesComplete} parallel calls are back — ${totalSources} sources total. Synthesizing the briefing now.`
              );
            }
          } else if (e.kind === "workflow.failed") {
            clearTimeout(timer);
            unsubscribe();
            resolve(
              "Some research branches failed — I'll synthesize with what came back."
            );
          }
        });
      });
    })();
    return waitForBranchesPromise;
  }

  async function deliverBriefing(): Promise<string> {
    if (deliverBriefingPromise) return deliverBriefingPromise;
    deliverBriefingPromise = (async () => {
      if (state.briefingText) return state.briefingText;
      try {
        const ev = await waitForEvent({
          events,
          sessionId,
          kind: "briefing.ready",
          timeoutMs: 300_000,
        });
        const briefing = await getBriefing(databaseUrl, ev.briefingId);
        state.briefingText =
          briefing?.content ?? "The briefing finished but returned no content.";
        return state.briefingText;
      } catch (err) {
        logger.warn({ err, sessionId }, "deliver_briefing failed");
        deliverBriefingPromise = null;
        return "The briefing workflow didn't complete in time.";
      }
    })();
    return deliverBriefingPromise;
  }

  async function handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case "start_research":
        return startResearch(String(args.topic ?? ""));
      case "wait_for_plan":
        return waitForPlan();
      case "wait_for_branches":
        return waitForBranches();
      case "deliver_briefing":
        return deliverBriefing();
      default:
        logger.warn({ name }, "unknown tool call");
        return "";
    }
  }

  try {
    session = await voice.openSession({
      sessionId,
      systemPrompt: SYSTEM_PROMPT,
      greeting: GREETING,
      tools: TOOLS,
      onUserTurn: async (topic) => startResearch(topic),
      onToolCall: handleToolCall,
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
          // Fallback: if the agent never calls start_research, fire it from
          // the first final transcript.
          if (e.kind === "user.transcript.final" && e.text.trim()) {
            startResearch(e.text.trim()).catch(() => {});
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

  // No phase-event forwarding here — the SSE route at /api/sessions/:id/events
  // is the single source of truth for phase events → browser. Forwarding from
  // both paths caused every event to render twice in the chat log.

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
    session?.close().catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);

  safeSend(browser, { type: "ready" });
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
