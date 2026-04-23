import { z } from "zod";

/**
 * Phase events drive the frontend chain ribbon and the backend activity log.
 * They are NOT spoken — voice output comes exclusively from AssemblyAI's
 * agent (greeting + tool.result replies + the briefing).
 *
 * Every event has a `sessionId` (scope) and `at` (ms timestamp). `kind` discriminates.
 * Keep payloads small — these fly through Postgres NOTIFY (8kB hard limit).
 */

export const Tier = z.enum(["lite", "standard", "deep"]);
export type Tier = z.infer<typeof Tier>;

const base = { sessionId: z.string(), at: z.number() } as const;

export const PhaseEventSchema = z.discriminatedUnion("kind", [
  // ── session lifecycle ────────────────────────────────────────────
  z.object({ ...base, kind: z.literal("session.started"), topic: z.string() }),
  z.object({ ...base, kind: z.literal("session.ended") }),

  // ── workflow lifecycle ────────────────────────────────────────────
  z.object({ ...base, kind: z.literal("workflow.dispatched"), runId: z.string() }),
  z.object({ ...base, kind: z.literal("workflow.started"), runId: z.string() }),
  z.object({ ...base, kind: z.literal("workflow.completed"), runId: z.string(), briefingId: z.string() }),
  z.object({ ...base, kind: z.literal("workflow.failed"), runId: z.string(), message: z.string() }),

  // ── agent phases (inside workflow) ────────────────────────────────
  z.object({ ...base, kind: z.literal("agent.planning"), step: z.enum(["decomposing_topic", "choosing_tier"]) }),
  z.object({
    ...base,
    kind: z.literal("plan.ready"),
    queries: z.array(z.object({ query: z.string(), tier: Tier, angle: z.string() })),
  }),
  z.object({ ...base, kind: z.literal("agent.synthesizing") }),

  // ── ask shape classification (narrative / enumeration / …) ───────
  z.object({
    ...base,
    kind: z.literal("ask.classified"),
    shape: z.enum(["narrative", "enumeration", "comparison", "specific", "recent"]),
  }),

  // ── verify (self-evaluation of briefing vs. user ask) ────────────
  z.object({ ...base, kind: z.literal("verify.started") }),
  z.object({
    ...base,
    kind: z.literal("verify.passed"),
    reason: z.string(),
  }),
  z.object({
    ...base,
    kind: z.literal("verify.failed"),
    reason: z.string(),
    feedback: z.string(),
  }),
  z.object({
    ...base,
    kind: z.literal("research.retrying"),
    attempt: z.number(),
    feedback: z.string(),
  }),

  // ── You.com ───────────────────────────────────────────────────────
  z.object({ ...base, kind: z.literal("youcom.call.started"), query: z.string(), tier: Tier }),
  z.object({
    ...base,
    kind: z.literal("youcom.call.completed"),
    query: z.string(),
    tier: Tier,
    sourceCount: z.number(),
    latencyMs: z.number(),
  }),

  // ── briefing payload is ready ─────────────────────────────────────
  z.object({
    ...base,
    kind: z.literal("briefing.ready"),
    briefingId: z.string(),
    sourceCount: z.number(),
  }),

]);

export type PhaseEvent = z.infer<typeof PhaseEventSchema>;
export type PhaseEventKind = PhaseEvent["kind"];

export function parsePhaseEvent(raw: unknown): PhaseEvent | null {
  const parsed = PhaseEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Which vendor "lane" an event belongs to, for the frontend chain ribbon. */
export function laneOf(kind: PhaseEventKind): "assembly" | "render" | "mastra" | "youcom" | "meta" {
  if (kind === "session.started") return "assembly";
  if (kind.startsWith("workflow.") || kind === "briefing.ready" || kind === "research.retrying") return "render";
  if (kind.startsWith("agent.") || kind === "plan.ready" || kind.startsWith("verify.") || kind === "ask.classified") return "mastra";
  if (kind.startsWith("youcom.")) return "youcom";
  return "meta";
}
