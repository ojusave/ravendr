// Orchestrator: connects the mic button to the WebSocket + SSE + ribbon + chat.

import {
  startSession,
  openEventStream,
  openClientSocket,
  fetchBriefing,
} from "/api-client.js";
import { startCapture, createPlayer } from "/mic.js";
import { createRibbon } from "/chain-ribbon.js";

const micEl = document.getElementById("mic");
const orbWrapEl = document.getElementById("orbWrap");
const iconMicEl = document.getElementById("iconMic");
const iconStopEl = document.getElementById("iconStop");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const feedHeaderEl = document.getElementById("feed-header");
const feedLabelEl = document.getElementById("feed-label");
const briefingEl = document.getElementById("briefing");
const briefingTopic = document.getElementById("briefing-topic");
const briefingBody = document.getElementById("briefing-body");
const briefingSources = document.getElementById("briefing-sources");
const ribbon = createRibbon(document.getElementById("ribbon"));

function setMicActive(on) {
  orbWrapEl?.classList.toggle("active", on);
  micEl?.classList.toggle("recording", on);
  if (iconMicEl && iconStopEl) {
    iconMicEl.style.display = on ? "none" : "block";
    iconStopEl.style.display = on ? "block" : "none";
  }
  statusEl?.classList.toggle("active", on);
  const timer = document.getElementById("session-timer");
  if (timer) {
    timer.classList.toggle("active", on);
    if (on) {
      const started = Date.now();
      const tick = () => {
        if (!timer.classList.contains("active")) return;
        const s = Math.floor((Date.now() - started) / 1000);
        timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        requestAnimationFrame(() => setTimeout(tick, 500));
      };
      tick();
    }
  }
}

const KIND_CLASS = {
  "session.started": "kind-assembly",
  "ask.classified": "kind-mastra",
  "plan.ready": "kind-mastra",
  "agent.planning": "kind-mastra",
  "agent.synthesizing": "kind-mastra",
  "verify.started": "kind-mastra",
  "verify.passed": "kind-mastra",
  "verify.failed": "kind-mastra",
  "youcom.call.started": "kind-youcom",
  "youcom.call.completed": "kind-youcom",
  "workflow.dispatched": "kind-render",
  "workflow.started": "kind-render",
  "workflow.completed": "kind-render",
  "workflow.failed": "kind-render",
  "research.retrying": "kind-render",
  "briefing.ready": "kind-briefing",
};

let active = false;
let stopCapture = null;
let ws = null;
let closeEvents = null;
let pendingUserBubble = null;
const player = createPlayer();

function setStatus(text) {
  statusEl.textContent = text;
}

function clearEmptyState() {
  const empty = logEl.querySelector(".empty");
  if (empty) empty.remove();
}

function chatBubble(role, text, mode) {
  clearEmptyState();
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.innerHTML = `<div class="who">${role === "user" ? "you" : "assistant"}</div><div class="text">${escape(text)}</div>`;
  if (mode === "pending") el.style.opacity = "0.6";
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function log(line, event) {
  clearEmptyState();
  const el = document.createElement("div");
  const kindClass = event?.kind ? KIND_CLASS[event.kind] ?? "" : "";
  el.className = `line ${kindClass}`.trim();
  const stamp = new Date(event?.at ?? Date.now()).toLocaleTimeString();
  el.innerHTML = `<span class="indicator"></span><span class="stamp">${stamp}</span><span class="msg">${line}</span>`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function handleTranscript(msg) {
  if (msg.role === "assistant") {
    chatBubble("assistant", msg.text);
    return;
  }
  if (msg.role !== "user") return;
  if (msg.final) {
    if (pendingUserBubble) {
      pendingUserBubble.querySelector(".text").textContent = msg.text;
      pendingUserBubble.style.opacity = "1";
      pendingUserBubble = null;
    } else {
      chatBubble("user", msg.text);
    }
  } else {
    if (!pendingUserBubble) {
      pendingUserBubble = chatBubble("user", msg.text, "pending");
    } else {
      pendingUserBubble.querySelector(".text").textContent = msg.text;
    }
  }
}

// All voice output comes from AssemblyAI. Phase events drive only the
// chain ribbon + backend activity log — never a chat bubble. Chat bubbles
// are strictly: user speech + agent spoken text (from AssemblyAI).

function handleEvent(event) {
  ribbon.onEvent(event);

  const summary = summarize(event);
  if (summary) log(summary, event);

  if (event.kind === "session.started") {
    feedHeaderEl.classList.add("live");
    feedLabelEl.textContent = `researching · ${event.topic.slice(0, 48)}`;
    setStatus("Researching — watch the stack work.");
  } else if (event.kind === "briefing.ready") {
    feedHeaderEl.classList.remove("live");
    feedLabelEl.textContent = "research complete";
    showBriefing(event.briefingId);
  } else if (event.kind === "workflow.failed") {
    feedHeaderEl.classList.remove("live");
    feedLabelEl.textContent = "workflow failed";
    setStatus(`Error: ${event.message.slice(0, 80)}`);
  }
}

function summarize(e) {
  switch (e.kind) {
    case "session.started": return `session.started — ${e.topic}`;
    case "workflow.dispatched": return `workflow.dispatched — ${e.runId}`;
    case "workflow.started": return `workflow.started — ${e.runId}`;
    case "workflow.completed": return `workflow.completed — briefing ${e.briefingId}`;
    case "workflow.failed": return `workflow.failed — ${e.message}`;
    case "agent.planning": return `agent.planning — ${e.step}`;
    case "plan.ready": return `plan.ready — ${e.queries.length} queries: ${e.queries.map((q) => q.angle).join(", ")}`;
    case "ask.classified": return `ask.classified — shape: ${e.shape}`;
    case "agent.synthesizing": return "agent.synthesizing";
    case "verify.started": return "verify.started — checking briefing vs. ask";
    case "verify.passed": return `verify.passed — ${e.reason}`;
    case "verify.failed": return `verify.failed — ${e.reason}`;
    case "research.retrying": return `research.retrying (attempt ${e.attempt}) — ${e.feedback.slice(0, 80)}`;
    case "youcom.call.started": return `youcom.call.started — ${e.tier}`;
    case "youcom.call.completed": return `youcom.call.completed — ${e.sourceCount} sources — ${e.latencyMs}ms`;
    case "briefing.ready": return `briefing.ready — ${e.sourceCount} sources`;
    default: return null;
  }
}

async function showBriefing(briefingId) {
  try {
    const { briefing, sources } = await fetchBriefing(briefingId);
    briefingTopic.textContent = briefing.topic;
    briefingBody.textContent = briefing.content ?? "";
    briefingSources.innerHTML = "";
    for (const s of sources) {
      const row = document.createElement("div");
      row.className = "source";
      row.innerHTML = `<a href="${s.url}" target="_blank" rel="noopener">${escape(s.title)}</a>${
        s.snippet ? ` — <span style="color:var(--muted)">${escape(s.snippet.slice(0, 200))}</span>` : ""
      }`;
      briefingSources.appendChild(row);
    }
    briefingEl.classList.add("show");
    setStatus("Briefing ready.");
  } catch (err) {
    setStatus(`Failed to load briefing: ${err.message}`);
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function start() {
  if (active) return;
  active = true;
  setMicActive(true);
  setStatus("Connecting…");
  ribbon.reset();
  logEl.innerHTML = "";
  feedHeaderEl.classList.remove("live");
  feedLabelEl.textContent = "activity";
  briefingEl.classList.remove("show");
  pendingUserBubble = null;

  const startResp = await fetch("/api/start", { method: "POST" }).then((r) => r.json());
  if (startResp.error) {
    setStatus(`Start failed: ${startResp.error.message}`);
    active = false;
    setMicActive(false);
    return;
  }
  const sessionId = startResp.data.sessionId;
  const runId = startResp.data.runId;
  log(`workflow dispatched · ${runId}`);

  // If the task doesn't connect back in 15s, surface a clear error with
  // the runId so the user can jump straight to the Render task logs.
  const connectTimer = setTimeout(() => {
    setStatus(`Task ${runId} didn't connect back — check its Render workflow logs.`);
    log(
      `Task ${runId} didn't connect back within 15s. Open Render dashboard → ravendr-workflow → Runs → ${runId} for details.`
    );
  }, 15_000);

  closeEvents = openEventStream(sessionId, handleEvent);
  ws = openClientSocket(sessionId, {
    onReady: () => {
      clearTimeout(connectTimer);
      setStatus("Listening — say a topic.");
    },
    onAudio: (b64) => player.enqueue(b64),
    onTranscript: handleTranscript,
    onError: (msg) => {
      clearTimeout(connectTimer);
      setStatus(`Voice error: ${msg}`);
      log(`error: ${msg}`);
    },
    onClose: () => {
      clearTimeout(connectTimer);
      if (active) stop();
    },
  });

  try {
    stopCapture = await startCapture((audio) => {
      // Guard: WS may have closed mid-capture; ignore trailing frames.
      if (ws && active) ws.send({ type: "audio", audio });
    });
  } catch (err) {
    setStatus(`Mic denied: ${err.message}`);
    await stop();
  }
}

async function stop() {
  if (!active) return;
  active = false;
  setMicActive(false);
  setStatus("Stopped");
  stopCapture?.();
  ws?.close();
  closeEvents?.();
  stopCapture = null; ws = null; closeEvents = null;
}

micEl.addEventListener("click", () => (active ? stop() : start()));
