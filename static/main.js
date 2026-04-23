// Orchestrator: connects the mic button to the WebSocket + SSE + ribbon + chat.

import {
  createSession,
  openEventStream,
  openVoiceSocket,
  fetchBriefing,
} from "/api-client.js";
import { startCapture, createPlayer } from "/mic.js";
import { createRibbon } from "/chain-ribbon.js";

const micEl = document.getElementById("mic");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const briefingEl = document.getElementById("briefing");
const briefingTopic = document.getElementById("briefing-topic");
const briefingBody = document.getElementById("briefing-body");
const briefingSources = document.getElementById("briefing-sources");
const ribbon = createRibbon(document.getElementById("ribbon"));

let active = false;
let stopCapture = null;
let ws = null;
let closeEvents = null;
let pendingUserBubble = null;
const player = createPlayer();

function setStatus(text) {
  statusEl.textContent = text;
}

function chatBubble(role, text, mode) {
  const el = document.createElement("div");
  el.className = `line bubble-${role}`;
  el.innerHTML = `<b>${role === "user" ? "you" : role}</b> · ${escape(text)}`;
  if (mode === "pending") el.style.opacity = "0.6";
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function log(line, event) {
  const el = document.createElement("div");
  el.className = "line";
  const stamp = new Date(event?.at ?? Date.now()).toLocaleTimeString();
  el.innerHTML = `<b>${stamp}</b> · ${line}`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function handleTranscript(msg) {
  if (msg.role === "assistant") {
    // AssemblyAI already TTS'd this via reply.audio; just render the text.
    chatBubble("assistant", msg.text);
    return;
  }
  if (msg.role !== "user") return;
  if (msg.final) {
    if (pendingUserBubble) {
      pendingUserBubble.innerHTML = `<b>you</b> · ${escape(msg.text)}`;
      pendingUserBubble.style.opacity = "1";
      pendingUserBubble = null;
    } else {
      chatBubble("user", msg.text);
    }
  } else {
    if (!pendingUserBubble) {
      pendingUserBubble = chatBubble("user", msg.text, "pending");
    } else {
      pendingUserBubble.innerHTML = `<b>you</b> · ${escape(msg.text)}`;
    }
  }
}

// Browser TTS for narrator lines. AssemblyAI's VA has no server-initiated
// speech API, so narrator phase lines are spoken here instead.
const NARRATOR_VOICE = (() => {
  try {
    const voices = window.speechSynthesis?.getVoices() ?? [];
    return voices.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|allison|karen/i.test(v.name))
        ?? voices.find((v) => /en/i.test(v.lang))
        ?? null;
  } catch {
    return null;
  }
})();

function speakNarration(text) {
  if (!("speechSynthesis" in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  if (NARRATOR_VOICE) u.voice = NARRATOR_VOICE;
  u.rate = 1.05;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

function handleEvent(event) {
  ribbon.onEvent(event);

  // Render narrator speech as assistant bubbles in chat AND speak it aloud.
  if (event.kind === "narrator.speech") {
    chatBubble("assistant", event.text);
    speakNarration(event.text);
    return;
  }

  const summary = summarize(event);
  if (summary) log(summary, event);

  if (event.kind === "briefing.ready") {
    showBriefing(event.briefingId);
  } else if (event.kind === "workflow.failed") {
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
    case "agent.synthesizing": return "agent.synthesizing";
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
    setStatus("Done. Scroll to read.");
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
  micEl.classList.add("active");
  setStatus("Connecting…");
  ribbon.reset();
  logEl.innerHTML = "";
  briefingEl.classList.remove("show");
  pendingUserBubble = null;

  const sessionId = await createSession();
  closeEvents = openEventStream(sessionId, handleEvent);
  ws = openVoiceSocket(sessionId, {
    onReady: () => setStatus("Listening — say a topic."),
    onAudio: (b64) => player.enqueue(b64),
    onEvent: handleEvent,
    onTranscript: handleTranscript,
    onError: (msg) => {
      setStatus(`Voice error: ${msg}`);
      log(`error: ${msg}`);
    },
    onClose: () => {
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
  micEl.classList.remove("active");
  setStatus("Stopped");
  stopCapture?.();
  ws?.close();
  closeEvents?.();
  stopCapture = null; ws = null; closeEvents = null;
}

micEl.addEventListener("click", () => (active ? stop() : start()));
