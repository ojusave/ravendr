import { apiGetJson, fetchSsePost, readSseStream } from "./api-client.js";

const GITHUB_REPO = "https://github.com/ojusave/ravendr";

function renderSignupUrlWithUtms(content = "footer_link") {
  const params = new URLSearchParams({
    utm_source: "github",
    utm_medium: "referral",
    utm_campaign: "ojus_demos",
    utm_content: content,
  });
  return `https://render.com/register?${params.toString()}`;
}

document.getElementById("signup-btn").href = renderSignupUrlWithUtms("navbar_button");
document.getElementById("deploy-btn").href = `https://render.com/deploy?repo=${encodeURIComponent(GITHUB_REPO)}`;
document.getElementById("github-btn").href = GITHUB_REPO;
document.getElementById("footer-github").href = GITHUB_REPO;
document.getElementById("footer-signup").href = renderSignupUrlWithUtms("footer_link");

const statusDot = document.getElementById("status-dot");
const micBtn = document.getElementById("mic-btn");
const micLabel = document.getElementById("mic-label");
const welcome = document.getElementById("welcome");
const conversation = document.getElementById("conversation");
const controls = document.getElementById("controls");
const knowledgePanel = document.getElementById("knowledge-panel");
const workflowList = document.getElementById("workflow-list");
const reportCard = document.getElementById("report-card");
const btnKnowledge = document.getElementById("btn-knowledge");
const btnDisconnect = document.getElementById("btn-disconnect");
const pipelineFeed = document.getElementById("pipeline-feed");
const pipelineError = document.getElementById("pipeline-error");
const pipelineTimer = document.getElementById("pipeline-timer");
const btnPipeIngest = document.getElementById("btn-pipe-ingest");
const btnPipeRecall = document.getElementById("btn-pipe-recall");
const btnPipeReport = document.getElementById("btn-pipe-report");
const btnPipeCancel = document.getElementById("btn-pipe-cancel");
const pipelineDashboard = document.getElementById("pipeline-dashboard");
const pipelineResult = document.getElementById("pipeline-result");
const pipelineResultContent = document.getElementById("pipeline-result-content");

// New voice-first UI elements
const voiceHero = document.getElementById("voice-hero");
const conversationPanel = document.getElementById("conversation-panel");
const pipelinePanel = document.getElementById("pipeline-panel");
const textFallback = document.getElementById("text-fallback");
const textFallbackToggle = document.getElementById("text-fallback-toggle");
const textFallbackForm = document.getElementById("text-fallback-form");

// Tech step elements
const techSteps = {
  workflows: {
    el: document.getElementById("step-workflows"),
    status: document.getElementById("status-workflows"),
    detail: document.getElementById("detail-workflows"),
    time: document.getElementById("time-workflows"),
    startTime: null,
  },
  youcom: {
    el: document.getElementById("step-youcom"),
    status: document.getElementById("status-youcom"),
    detail: document.getElementById("detail-youcom"),
    time: document.getElementById("time-youcom"),
    startTime: null,
  },
  mastra: {
    el: document.getElementById("step-mastra"),
    status: document.getElementById("status-mastra"),
    detail: document.getElementById("detail-mastra"),
    time: document.getElementById("time-mastra"),
    startTime: null,
  },
  complete: {
    el: document.getElementById("step-complete"),
    status: document.getElementById("status-complete"),
    detail: document.getElementById("detail-complete"),
    time: document.getElementById("time-complete"),
    startTime: null,
  },
};

function setTechStep(stepName, state, statusText, detailText = "") {
  const step = techSteps[stepName];
  if (!step) return;

  // Update class
  step.el.className = `tech-step ${state}`;

  // Update status text
  if (statusText) step.status.textContent = statusText;
  if (detailText) step.detail.textContent = detailText;

  // Handle timing
  if (state === "active" && !step.startTime) {
    step.startTime = Date.now();
    step.time.textContent = "0.0s";
  } else if (state === "done" || state === "error") {
    if (step.startTime) {
      const elapsed = ((Date.now() - step.startTime) / 1000).toFixed(1);
      step.time.textContent = `${elapsed}s`;
    }
  }
}

function resetTechPipeline() {
  for (const [name, step] of Object.entries(techSteps)) {
    step.el.className = "tech-step waiting";
    step.startTime = null;
    step.time.textContent = "—";
    step.detail.textContent = "";
  }
  techSteps.workflows.status.textContent = "Waiting to dispatch task...";
  techSteps.youcom.status.textContent = "Waiting for task...";
  techSteps.mastra.status.textContent = "Waiting for research...";
  techSteps.complete.status.textContent = "Waiting for synthesis...";

  pipelineResult.classList.remove("visible");
  pipelineResultContent.textContent = "";
}

apiGetJson("/api/config")
  .then((cfg) => {
    if (cfg && cfg.dashboardTasksUrl && pipelineDashboard) {
      pipelineDashboard.href = cfg.dashboardTasksUrl;
    }
  })
  .catch(() => {});

let pipelineController = null;
let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let connected = false;
const workflows = [];
let voicePipelineTimer = null;
let voicePipelineStart = null;

function startVoicePipelineTimer() {
  stopVoicePipelineTimer();
  voicePipelineStart = Date.now();
  pipelineTimer.textContent = "0.0s";
  voicePipelineTimer = setInterval(() => {
    const elapsed = ((Date.now() - voicePipelineStart) / 1000).toFixed(1);
    pipelineTimer.textContent = `${elapsed}s`;
    // Update active step timers
    for (const step of Object.values(techSteps)) {
      if (step.el.className.includes("active") && step.startTime) {
        step.time.textContent = `${((Date.now() - step.startTime) / 1000).toFixed(1)}s`;
      }
    }
  }, 100);
}

function stopVoicePipelineTimer() {
  if (voicePipelineTimer) {
    clearInterval(voicePipelineTimer);
    voicePipelineTimer = null;
  }
  if (voicePipelineStart) {
    const elapsed = ((Date.now() - voicePipelineStart) / 1000).toFixed(1);
    pipelineTimer.textContent = `${elapsed}s total`;
    voicePipelineStart = null;
  }
}

function addMessage(text, type = "agent") {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
}

function addWorkflow(id, type, status) {
  workflows.unshift({ id, type, status, time: new Date() });
  renderWorkflows();
}

function updateWorkflow(id, status) {
  const wf = workflows.find((w) => w.id === id);
  if (wf) wf.status = status;
  renderWorkflows();
}

function renderWorkflows() {
  workflowList.innerHTML = workflows
    .slice(0, 10)
    .map(
      (w) => `
        <div class="workflow-item">
          <div class="workflow-dot ${w.status}"></div>
          <span class="workflow-type">${w.type}</span>
          <span class="workflow-id">${w.id.slice(0, 12)}...</span>
          <span class="workflow-time">${w.time.toLocaleTimeString()}</span>
        </div>
      `
    )
    .join("");
}

async function startConversation() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/voice`);

  ws.onopen = () => {
    connected = true;
    statusDot.className = "dot live";
    micLabel.textContent = "Connecting to voice agent...";
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data);
    } catch (e) {
      console.warn("Non-JSON WS message", e);
    }
  };

  ws.onclose = () => {
    disconnect();
  };

  ws.onerror = () => {
    addMessage("Connection error. Please try again.", "system");
    disconnect();
  };
}

function handleEvent(event) {
  const t = event.type;

  if (t === "session.ready") {
    statusDot.className = "dot recording";
    micLabel.textContent = "Listening...";
    micBtn.classList.add("active");
    // Show conversation and pipeline panels
    if (voiceHero) voiceHero.classList.add("speaking");
    if (conversationPanel) conversationPanel.classList.add("visible");
    if (pipelinePanel) pipelinePanel.classList.add("visible");
    if (textFallback) textFallback.style.display = "none";
    startMicrophone();
  } else if (t === "input.speech.started") {
    micLabel.textContent = "Listening...";
  } else if (t === "input.speech.stopped") {
    micLabel.textContent = "Processing...";
  } else if (t === "transcript.user") {
    addMessage(event.text, "user");
  } else if (t === "pipeline") {
    // Show pipeline visualization for voice-triggered workflows
    if (event.sseEvent === "status" && event.data?.phase === "dispatching") {
      // New voice workflow starting - reset and start timer
      resetTechPipeline();
      startVoicePipelineTimer();
      setTechStep("workflows", "active", "Dispatching task...");
    }
    appendPipelineSseEvent(event.sseEvent || "message", event.data || {});
    if (event.data?.taskRunId && event.sseEvent === "started") {
      addWorkflow(event.data.taskRunId, "workflow", "running");
    }
    if (event.sseEvent === "done" || event.sseEvent === "error") {
      stopVoicePipelineTimer();
    }
  } else if (t === "transcript.agent") {
    addMessage(event.text, "agent");

    if (event.text && event.text.includes("background")) {
      const idMatch = event.text.match(/trn-\w+/);
      if (idMatch) addWorkflow(idMatch[0], "ingest", "running");
    }
  } else if (t === "reply.audio") {
    playAudio(event.data);
  } else if (t === "reply.done") {
    micLabel.textContent = "Listening...";
  } else if (t === "error" || t === "session.error") {
    addMessage(`Error: ${event.message || "Unknown error"}`, "system");
  }
}

let playbackCtx = null;
let nextPlayTime = 0;

async function playAudio(base64Data) {
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = playbackCtx.currentTime;
  }
  if (playbackCtx.state === "suspended") {
    try {
      await playbackCtx.resume();
    } catch (e) {
      console.warn("AudioContext.resume failed", e);
    }
  }

  const raw = atob(base64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

async function startMicrophone() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true },
    });

    audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
      }

      const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
      ws.send(JSON.stringify({ type: "input.audio", audio: base64 }));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  } catch (err) {
    addMessage("Microphone access denied. Please allow microphone access.", "system");
    disconnect();
  }
}

function disconnect() {
  connected = false;
  statusDot.className = "dot";
  micBtn.classList.remove("active");
  micLabel.textContent = "Click to start";

  // Hide panels, show hero
  if (voiceHero) voiceHero.classList.remove("speaking");
  if (conversationPanel) conversationPanel.classList.remove("visible");
  if (pipelinePanel) pipelinePanel.classList.remove("visible");
  if (textFallback) textFallback.style.display = "";

  // Clear conversation
  if (conversation) conversation.innerHTML = "";

  // Stop voice pipeline timer
  stopVoicePipelineTimer();
  resetTechPipeline();

  if (ws) {
    ws.close();
    ws = null;
  }
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (playbackCtx) {
    playbackCtx.close();
    playbackCtx = null;
  }
  nextPlayTime = 0;
}

micBtn.addEventListener("click", () => {
  if (connected) {
    disconnect();
  } else {
    startConversation();
  }
});

btnDisconnect.addEventListener("click", () => {
  disconnect();
  controls.style.display = "none";
  welcome.style.display = "";
  conversation.classList.remove("visible");
});

btnKnowledge.addEventListener("click", () => {
  knowledgePanel.classList.toggle("visible");
});

function setPipelineBusy(busy) {
  btnPipeIngest.disabled = busy;
  btnPipeRecall.disabled = busy;
  btnPipeReport.disabled = busy;
  btnPipeCancel.classList.toggle("visible", busy);
}

function resetPipelineUi() {
  pipelineFeed.innerHTML = "";
  pipelineError.textContent = "";
  pipelineError.classList.remove("visible");
  pipelineTimer.textContent = "Ready";
  resetTechPipeline();
}

function appendPipelineRow(parts, variant = "") {
  const row = document.createElement("div");
  row.className = "activity-row " + variant;
  for (const p of parts) {
    if (typeof p === "string") {
      row.appendChild(document.createTextNode(p));
    } else {
      row.appendChild(p);
    }
  }
  pipelineFeed.appendChild(row);
  pipelineFeed.scrollTop = pipelineFeed.scrollHeight;
}

/** Update tech pipeline visualization based on SSE events */
function updateTechPipelineFromEvent(eventName, data) {
  const phase = data.phase || "";
  const techPhase = data.techPhase || "";
  const elapsed = data.elapsed || 0;

  if (eventName === "status") {
    // Update based on phase info
    if (phase === "dispatching") {
      setTechStep("workflows", "active", "Dispatching durable task...");
    } else if (phase === "running") {
      // Task is running - check techPhase for which component is active
      if (techPhase === "youcom" || techPhase === "research") {
        setTechStep("workflows", "done", "Task dispatched");
        setTechStep("youcom", "active", "Searching the web...", data.query || "");
      } else if (techPhase === "mastra" || techPhase === "synthesis") {
        setTechStep("youcom", "done", "Research complete", `${data.sourceCount || "?"} sources found`);
        setTechStep("mastra", "active", "AI synthesizing results...");
      } else {
        // Estimate phase based on elapsed time since we don't have detailed phase info
        // Typical timing: 0-2s dispatch, 2-15s You.com, 15-30s Mastra
        if (!techSteps.workflows.el.className.includes("done")) {
          setTechStep("workflows", "done", "Task dispatched");
        }

        if (elapsed < 8) {
          if (!techSteps.youcom.el.className.includes("active") && !techSteps.youcom.el.className.includes("done")) {
            setTechStep("youcom", "active", "Researching with You.com...");
          }
        } else if (elapsed < 25) {
          if (!techSteps.youcom.el.className.includes("done")) {
            setTechStep("youcom", "done", "Research data gathered");
          }
          if (!techSteps.mastra.el.className.includes("active") && !techSteps.mastra.el.className.includes("done")) {
            setTechStep("mastra", "active", "Mastra AI synthesizing...");
          }
        } else {
          if (!techSteps.mastra.el.className.includes("done")) {
            setTechStep("mastra", "done", "AI processing complete");
          }
          if (!techSteps.complete.el.className.includes("active")) {
            setTechStep("complete", "active", "Finalizing results...");
          }
        }
      }
    }
  } else if (eventName === "started") {
    setTechStep("workflows", "done", "Task dispatched", `ID: ${(data.taskRunId || "").slice(0, 16)}...`);
    setTechStep("youcom", "active", "Starting web research...");
    if (data.dashboardUrl && pipelineDashboard) {
      pipelineDashboard.href = data.dashboardUrl;
    }
  } else if (eventName === "done") {
    // Mark all steps complete
    setTechStep("workflows", "done", "Task orchestrated");
    setTechStep("youcom", "done", "Web research complete");
    setTechStep("mastra", "done", "AI synthesis complete");
    setTechStep("complete", "done", "Pipeline finished!", `Total: ${elapsed}s`);

    // Show result
    const result = data.result || {};
    let displayText = "";
    if (result.briefing) {
      displayText = result.briefing;
    } else if (result.content) {
      displayText = result.content;
    } else if (result.summary) {
      displayText = result.summary;
    } else if (result.entryId) {
      displayText = `✅ Knowledge stored successfully!\n\nEntry ID: ${result.entryId}\nConfidence: ${((result.confidence || 0) * 100).toFixed(0)}%`;
    } else {
      displayText = JSON.stringify(result, null, 2);
    }
    pipelineResultContent.textContent = displayText.slice(0, 2000);
    pipelineResult.classList.add("visible");
  } else if (eventName === "error") {
    // Mark current active step as error
    let foundActive = false;
    for (const [name, step] of Object.entries(techSteps)) {
      if (step.el.className.includes("active")) {
        setTechStep(name, "error", `Error: ${data.message || "Unknown"}`);
        foundActive = true;
        break;
      }
    }
    if (!foundActive) {
      // Default to marking youcom as error
      setTechStep("youcom", "error", `Error: ${data.message || "Unknown"}`);
    }
  }
}

/** Same rows for HTTP SSE (`runSsePipeline`) and voice WebSocket `pipeline` events. */
function appendPipelineSseEvent(eventName, data) {
  if (!data || typeof data !== "object") data = {};

  // Update the visual pipeline
  updateTechPipelineFromEvent(eventName, data);

  // Legacy feed (hidden but kept for compatibility)
  if (eventName === "status") {
    const w = data.workflowStatus ? ` ${data.workflowStatus}` : "";
    const strong = document.createElement("strong");
    strong.textContent = data.phase || "status";
    appendPipelineRow([strong, document.createTextNode(`${w} (${data.elapsed ?? 0}s)`)]);
  } else if (eventName === "started") {
    appendPipelineRow([
      document.createTextNode("Task run "),
      (() => {
        const code = document.createElement("code");
        code.textContent = (data.taskRunId || "").slice(0, 36);
        return code;
      })(),
    ]);
  } else if (eventName === "done") {
    appendPipelineRow([document.createTextNode("Done")], "done");
  } else if (eventName === "error") {
    const msg = typeof data === "string" ? data : data.message || JSON.stringify(data);
    pipelineError.textContent = msg;
    pipelineError.classList.add("visible");
    appendPipelineRow([document.createTextNode("Error: " + msg)], "err");
  }
}

async function runSsePipeline(url, bodyObj) {
  if (pipelineController) {
    pipelineController.abort();
  }
  pipelineController = new AbortController();
  const signal = pipelineController.signal;
  setPipelineBusy(true);
  resetPipelineUi();

  // Start with workflows step active
  setTechStep("workflows", "active", "Dispatching task to Render Workflows...");

  const t0 = Date.now();
  const tick = setInterval(() => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    pipelineTimer.textContent = `${elapsed}s`;

    // Update active step timers
    for (const step of Object.values(techSteps)) {
      if (step.el.className.includes("active") && step.startTime) {
        step.time.textContent = `${((Date.now() - step.startTime) / 1000).toFixed(1)}s`;
      }
    }
  }, 100);

  try {
    const res = await fetchSsePost(url, bodyObj, signal);
    await readSseStream(res, appendPipelineSseEvent);
  } catch (e) {
    if (e && e.name === "AbortError") {
      // Mark current step as cancelled
      for (const [name, step] of Object.entries(techSteps)) {
        if (step.el.className.includes("active")) {
          setTechStep(name, "error", "Cancelled");
          break;
        }
      }
      return;
    }
    pipelineError.textContent = e && e.message ? e.message : String(e);
    pipelineError.classList.add("visible");
    // Mark current step as error
    for (const [name, step] of Object.entries(techSteps)) {
      if (step.el.className.includes("active")) {
        setTechStep(name, "error", e && e.message ? e.message : "Error");
        break;
      }
    }
  } finally {
    clearInterval(tick);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    pipelineTimer.textContent = `${elapsed}s total`;
    setPipelineBusy(false);
    pipelineController = null;
  }
}

btnPipeCancel.addEventListener("click", () => {
  if (pipelineController) pipelineController.abort();
});

btnPipeIngest.addEventListener("click", () => {
  const topic = document.getElementById("pipe-topic").value.trim();
  let claim = document.getElementById("pipe-claim").value.trim();
  if (!topic) {
    pipelineError.textContent = "Enter a topic to research.";
    pipelineError.classList.add("visible");
    return;
  }
  // Use topic as claim if no claim provided
  if (!claim) {
    claim = `Tell me about ${topic}`;
  }
  runSsePipeline("/api/pipeline/ingest", { topic, claim });
});

btnPipeRecall.addEventListener("click", () => {
  // Use topic input for recall query
  const query = document.getElementById("pipe-topic").value.trim();
  if (!query) {
    pipelineError.textContent = "Enter a topic to recall.";
    pipelineError.classList.add("visible");
    return;
  }
  // Update tech step labels for recall flow
  techSteps.youcom.status.textContent = "Searching knowledge base...";
  runSsePipeline("/api/pipeline/recall", { query });
});

btnPipeReport.addEventListener("click", () => {
  // Update tech step labels for report flow
  techSteps.youcom.status.textContent = "Gathering all knowledge...";
  techSteps.mastra.status.textContent = "Generating comprehensive report...";
  runSsePipeline("/api/pipeline/report", {});
});

setInterval(async () => {
  if (!connected) return;
  const running = workflows.filter((w) => w.status === "running");
  if (running.length === 0) return;

  try {
    const data = await apiGetJson("/api/workflows/recent");
    for (const run of data) {
      const existing = workflows.find((w) => w.id === run.id);
      if (existing && existing.status !== run.status) {
        existing.status = run.status;
      }
    }
    renderWorkflows();
  } catch {
    /* ignore poll errors */
  }
}, 5000);

// Text fallback toggle
if (textFallbackToggle && textFallbackForm) {
  textFallbackToggle.addEventListener("click", () => {
    textFallbackForm.classList.toggle("visible");
    textFallbackToggle.textContent = textFallbackForm.classList.contains("visible")
      ? "Hide text input"
      : "Can't use microphone? Try text input";
  });
}

// Show pipeline panel when text fallback is used
if (btnPipeIngest) {
  const originalHandler = btnPipeIngest.onclick;
  btnPipeIngest.addEventListener("click", () => {
    if (pipelinePanel) pipelinePanel.classList.add("visible");
  });
}
