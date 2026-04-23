// Manages the four-lane chain ribbon at the top of the page.

const LANE_BY_KIND = {
  "session.started": "assembly",
  "workflow.dispatched": "render",
  "workflow.started": "render",
  "workflow.completed": "render",
  "workflow.failed": "render",
  "briefing.ready": "render",
  "agent.planning": "mastra",
  "plan.ready": "mastra",
  "agent.synthesizing": "mastra",
  "youcom.call.started": "youcom",
  "youcom.call.completed": "youcom",
};

export function createRibbon(rootEl) {
  const nodes = Array.from(rootEl.querySelectorAll(".node"));
  const laneEls = Object.fromEntries(
    nodes.map((n) => [n.dataset.lane, n])
  );

  const activityTimers = new Map();
  const markActive = (lane) => {
    const el = laneEls[lane];
    if (!el) return;
    el.classList.add("active");
    el.classList.remove("done");
    const existing = activityTimers.get(lane);
    if (existing) clearTimeout(existing);
    activityTimers.set(
      lane,
      setTimeout(() => {
        el.classList.remove("active");
        el.classList.add("done");
      }, 1_800)
    );
  };

  const setSub = (lane, text) => {
    const el = laneEls[lane]?.querySelector("[data-field=sub]");
    if (el) el.textContent = text;
  };

  return {
    onEvent(event) {
      const lane = LANE_BY_KIND[event.kind];
      if (!lane) return;
      markActive(lane);
      switch (event.kind) {
        case "session.started":
          setSub("assembly", `listening: ${trimTopic(event.topic)}`);
          break;
        case "workflow.dispatched":
          setSub("render", `dispatched · ${shortId(event.runId)}`);
          break;
        case "workflow.started":
          setSub("render", `running · ${shortId(event.runId)}`);
          break;
        case "workflow.completed":
          setSub("render", `complete · ${shortId(event.runId)}`);
          break;
        case "workflow.failed":
          setSub("render", `failed: ${event.message.slice(0, 40)}`);
          break;
        case "briefing.ready":
          setSub("render", `briefing ready · ${event.sourceCount} sources`);
          break;
        case "agent.planning":
          setSub("mastra", `planning · ${event.step}`);
          break;
        case "plan.ready":
          setSub("mastra", `plan · ${event.queries.length} queries`);
          break;
        case "agent.synthesizing":
          setSub("mastra", "synthesizing");
          break;
        case "youcom.call.started":
          setSub("youcom", `${event.tier} · calling`);
          break;
        case "youcom.call.completed":
          setSub("youcom", `${event.tier} · ${event.sourceCount} sources · ${event.latencyMs}ms`);
          break;
      }
    },
    reset() {
      nodes.forEach((n) => {
        n.classList.remove("active", "done");
        const sub = n.querySelector("[data-field=sub]");
        if (sub) {
          sub.textContent = n.dataset.defaultSub ?? "";
        }
      });
    },
  };
}

function shortId(id) {
  return id ? id.slice(0, 8) : "";
}
function trimTopic(topic) {
  return topic.length > 32 ? topic.slice(0, 29) + "…" : topic;
}
