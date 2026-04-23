import type { PhaseEvent } from "../shared/events.js";

/**
 * Event → short spoken line. Multiple variants per kind so repeat demos
 * don't sound identical.
 */
type Template = (event: PhaseEvent) => string;

const pick = <T>(xs: T[]): T => {
  const i = Math.floor(Math.random() * xs.length);
  return xs[i] as T;
};

const TEMPLATES: Partial<Record<PhaseEvent["kind"], Template>> = {
  "session.started": (e) => {
    if (e.kind !== "session.started") return "";
    return pick([
      `Got it. Researching ${e.topic} now.`,
      `On it. Starting a run on ${e.topic}.`,
    ]);
  },
  "workflow.dispatched": () =>
    pick([
      "Dispatching a workflow on Render.",
      "Kicking off a Render workflow.",
      "Sending this to a Render workflow.",
    ]),
  "workflow.started": () =>
    pick([
      "Workflow's running.",
      "The workflow instance is up.",
    ]),
  "agent.planning": (e) => {
    if (e.kind !== "agent.planning") return "";
    return e.step === "decomposing_topic"
      ? pick(["Mastra's planning the approach.", "Breaking the topic down."])
      : pick(["Picking a research tier.", "Deciding how deep to go."]);
  },
  "plan.ready": (e) => {
    if (e.kind !== "plan.ready") return "";
    return pick([
      `Mastra drafted ${e.queries.length} research angles.`,
      `${e.queries.length} parallel queries lined up.`,
    ]);
  },
  "youcom.call.started": (e) => {
    if (e.kind !== "youcom.call.started") return "";
    if (e.tier === "deep") return "Calling You.com, deep tier — this takes a minute or two.";
    if (e.tier === "standard") return "Calling You.com, standard tier.";
    return "Quick You.com lookup.";
  },
  "youcom.call.completed": (e) => {
    if (e.kind !== "youcom.call.completed") return "";
    return pick([
      `Got ${e.sourceCount} sources back from You.com.`,
      `You.com returned ${e.sourceCount} sources.`,
    ]);
  },
  "agent.synthesizing": () =>
    pick([
      "Synthesizing the briefing.",
      "Mastra's weaving the sources together.",
    ]),
  "briefing.ready": () =>
    pick([
      "Briefing's ready. Here's what we learned.",
      "Done. Listen up.",
    ]),
  "workflow.completed": () => "",
  "workflow.failed": (e) => {
    if (e.kind !== "workflow.failed") return "";
    return `Something went wrong. ${e.message}`;
  },
};

export function narrateEvent(event: PhaseEvent): string | null {
  const template = TEMPLATES[event.kind];
  if (!template) return null;
  const line = template(event);
  return line.length > 0 ? line : null;
}
