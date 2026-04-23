// Orchestrator: connects the mic button to the WebSocket + SSE + ribbon + chat.

import {
  startSession,
  openEventStream,
  openClientSocket,
  fetchBriefing,
} from "/api-client.js";
import { startCapture, createPlayer } from "/mic.js";
import { createRibbon } from "/chain-ribbon.js";
import { marked } from "https://esm.sh/marked@14";

marked.setOptions({ breaks: true, gfm: true });

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
  if (timer) timer.classList.toggle("active", on);
}

/**
 * Countdown to the server-side session expiry. Frontend is just a
 * display — the server's cleanup daemon is authoritative, so even if
 * the clock drifts, expired sessions get cancelled server-side.
 */
function startExpiryCountdown(expiresAtMs) {
  const timer = document.getElementById("session-timer");
  if (!timer) return;
  timer.classList.add("active");
  const tick = () => {
    if (!active) return;
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      timer.textContent = "0:00";
      timer.classList.add("expired");
      setStatus("Session expired.");
      stop();
      return;
    }
    const s = Math.floor(remainingMs / 1000);
    timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    requestAnimationFrame(() => setTimeout(tick, 500));
  };
  tick();
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

// Category pill for each event kind — matches gradient-bang's HUD feel.
// event=amber, message=dim, thinking=purple, step=cyan, action=purple,
// complete=green, error=red.
const KIND_CATEGORY = {
  "session.started": "step",
  "workflow.dispatched": "action",
  "workflow.started": "action",
  "workflow.completed": "complete",
  "workflow.failed": "error",
  "ask.classified": "message",
  "agent.planning": "thinking",
  "plan.ready": "event",
  "agent.synthesizing": "thinking",
  "verify.started": "message",
  "verify.passed": "complete",
  "verify.failed": "event",
  "research.retrying": "message",
  "youcom.call.started": "event",
  "youcom.call.completed": "event",
  "briefing.ready": "complete",
};

function categoryOf(kind) {
  return KIND_CATEGORY[kind] || "event";
}

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

function log(line, event, options = {}) {
  clearEmptyState();
  const kindClass = event?.kind ? KIND_CLASS[event.kind] ?? "" : "";
  const kind = event?.kind ?? "";
  const category = options.category || categoryOf(kind);

  // Stack consecutive same-kind events. E.g. five youcom.call.started
  // firing nearly-simultaneously collapse into one line with "× 5".
  const last = logEl.lastElementChild;
  if (last?.classList.contains("line") && last.dataset.kind === kind && kind) {
    const count = Number(last.dataset.count ?? "1") + 1;
    last.dataset.count = String(count);
    let badge = last.querySelector(".count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "count";
      last.appendChild(badge);
    }
    badge.textContent = `× ${count}`;
    // Update message to the latest (captures updated detail like "3 of 5 done")
    const msg = last.querySelector(".msg");
    if (msg) msg.textContent = line;
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }

  const el = document.createElement("div");
  el.className = `line ${kindClass}`.trim();
  el.dataset.kind = kind;
  el.dataset.count = "1";
  const stamp = new Date(event?.at ?? Date.now()).toLocaleTimeString();
  el.innerHTML = `<span class="indicator"></span><span class="cat cat-${category}">${category}</span><span class="stamp">${stamp}</span><span class="msg"></span>`;
  el.querySelector(".msg").textContent = line;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Emits an interstitial MESSAGE line — "Reviewing latest results..." style.
 * Bridges perceptual gaps between big phase events so the feed never feels
 * stalled. Called by handleEvent on big transitions.
 */
function message(text) {
  log(text, { at: Date.now(), kind: "ui.message" }, { category: "message" });
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

  // Interstitial MESSAGE lines — gradient-bang-style "Reviewing latest
  // results…" placeholders during long waits so the feed never stalls.
  switch (event.kind) {
    case "session.started":
      message("Spinning up Render workflow…");
      break;
    case "ask.classified":
      message(
        `Routing through the ${event.shape}-shape pipeline…`
      );
      break;
    case "plan.ready":
      message(
        `Fanning out ${event.queries.length} parallel research calls…`
      );
      break;
    case "agent.synthesizing":
      message("Reviewing latest results…");
      break;
    case "verify.started":
      message("Checking briefing coverage against your ask…");
      break;
    case "verify.failed":
      message("Gaps found — kicking off a retry with corrected plan…");
      break;
    case "briefing.ready":
      message("Briefing ready — handing to voice…");
      break;
  }

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
    // Briefing body is markdown (bold, numbered lists, sub-headers from
    // the enumeration-shape synth). Render via marked.parse to get real
    // HTML instead of raw asterisks + run-together list items.
    briefingBody.innerHTML = marked.parse(briefing.content ?? "");
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
    const msg = startResp.error.message || "start failed";
    setStatus(
      startResp.error.code === "AT_CAPACITY"
        ? "Demo is busy — try again in a minute."
        : `Start failed: ${msg}`
    );
    active = false;
    setMicActive(false);
    return;
  }
  const sessionId = startResp.data.sessionId;
  const runId = startResp.data.runId;
  const expiresAt = startResp.data.expiresAt
    ? new Date(startResp.data.expiresAt).getTime()
    : null;
  log(`workflow dispatched · ${runId}`);

  // Countdown timer in the header — hard-capped at SESSION_LIFETIME_MINUTES
  // by the backend cleanup daemon. Show mm:ss remaining so users know their
  // budget.
  if (expiresAt) startExpiryCountdown(expiresAt);

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
