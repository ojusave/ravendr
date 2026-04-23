import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { EventBus, ResearchProvider, ResearchSource } from "../shared/ports.js";
import { Tier } from "../shared/events.js";
import { planResearch } from "./planner.js";
import { synthesize } from "./synthesizer.js";
import { addSources, completeBriefing, setSessionStatus } from "../render/db.js";
import { logger } from "../shared/logger.js";

/**
 * The research pipeline as a real Mastra Workflow.
 *
 *   planStep           (@anthropic-ai/sdk)
 *     → searchStep     (Promise.all of You.com calls)
 *     → synthesizeStep (@anthropic-ai/sdk, persists to Postgres)
 *
 * Each step's execute() calls raw vendor SDKs — no AI SDK dependency. Mastra
 * handles the composition, schema validation between steps, and the run
 * lifecycle. This workflow itself lives *inside* a Render Workflow task
 * (the durable envelope), so: Render Workflows outer, Mastra inner.
 */

export interface BriefingWorkflowDeps {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
  anthropicApiKey: string;
  anthropicModel: string;
}

// Shared context forwarded through every step so each step can emit scoped
// phase events and know its session.
const contextSchema = z.object({
  sessionId: z.string(),
  topic: z.string(),
  runId: z.string(),
  briefingId: z.string(),
});

const inputSchema = contextSchema;

const querySchema = z.object({
  query: z.string(),
  tier: Tier,
  angle: z.string(),
});

const branchSchema = z.object({
  angle: z.string(),
  query: z.string(),
  content: z.string(),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      snippet: z.string().optional(),
    })
  ),
});

const outputSchema = z.object({
  briefingId: z.string(),
  sourceCount: z.number(),
});

export function createBriefingWorkflow(deps: BriefingWorkflowDeps) {
  const emit = (event: Parameters<EventBus["publish"]>[0]) =>
    deps.events.publish(event).catch((err) =>
      logger.warn({ err }, "emit failed in Mastra step")
    );

  // ── Step 1: plan ───────────────────────────────────────────────────
  const planStep = createStep({
    id: "plan",
    inputSchema,
    outputSchema: contextSchema.extend({ queries: z.array(querySchema).min(1) }),
    execute: async ({ inputData }) => {
      await emit({
        sessionId: inputData.sessionId,
        at: Date.now(),
        kind: "agent.planning",
        step: "decomposing_topic",
      });
      const plan = await planResearch(inputData.topic, {
        apiKey: deps.anthropicApiKey,
        model: deps.anthropicModel,
      });
      await emit({
        sessionId: inputData.sessionId,
        at: Date.now(),
        kind: "plan.ready",
        queries: plan.queries.map((q) => ({
          query: q.query,
          tier: q.tier,
          angle: q.angle,
        })),
      });
      return { ...inputData, queries: plan.queries };
    },
  });

  // ── Step 2: parallel You.com search ────────────────────────────────
  const searchStep = createStep({
    id: "search",
    inputSchema: contextSchema.extend({ queries: z.array(querySchema) }),
    outputSchema: contextSchema.extend({ branches: z.array(branchSchema) }),
    execute: async ({ inputData }) => {
      const branches = await Promise.all(
        inputData.queries.map(async (q) => {
          await emit({
            sessionId: inputData.sessionId,
            at: Date.now(),
            kind: "youcom.call.started",
            query: q.query,
            tier: q.tier,
          });
          try {
            const r = await deps.research.research({
              query: q.query,
              tier: q.tier,
            });
            await emit({
              sessionId: inputData.sessionId,
              at: Date.now(),
              kind: "youcom.call.completed",
              query: q.query,
              tier: q.tier,
              sourceCount: r.sources.length,
              latencyMs: r.latencyMs,
            });
            return {
              angle: q.angle,
              query: q.query,
              content: r.content,
              sources: r.sources,
            };
          } catch (err) {
            logger.warn({ err, angle: q.angle }, "branch failed — skipping");
            return {
              angle: q.angle,
              query: q.query,
              content: "",
              sources: [] as ResearchSource[],
            };
          }
        })
      );
      return { ...inputData, branches };
    },
  });

  // ── Step 3: synthesize + persist ───────────────────────────────────
  const synthesizeStep = createStep({
    id: "synthesize",
    inputSchema: contextSchema.extend({ branches: z.array(branchSchema) }),
    outputSchema,
    execute: async ({ inputData }) => {
      const usable = inputData.branches.filter((b) => b.content.trim().length > 0);
      if (usable.length === 0) {
        throw new Error("all research branches failed");
      }

      await emit({
        sessionId: inputData.sessionId,
        at: Date.now(),
        kind: "agent.synthesizing",
      });

      const raw = await synthesize(
        inputData.topic,
        usable.map((b) => ({
          angle: b.angle,
          query: b.query,
          content: b.content,
        })),
        { apiKey: deps.anthropicApiKey, model: deps.anthropicModel }
      );
      const briefingContent = stripCitationMarkers(raw);
      const allSources = mergeSources(usable.flatMap((b) => b.sources));

      await completeBriefing(deps.databaseUrl, inputData.briefingId, briefingContent);
      await addSources(deps.databaseUrl, inputData.briefingId, allSources);
      await setSessionStatus(deps.databaseUrl, inputData.sessionId, "complete");

      await emit({
        sessionId: inputData.sessionId,
        at: Date.now(),
        kind: "briefing.ready",
        briefingId: inputData.briefingId,
        sourceCount: allSources.length,
      });

      return {
        briefingId: inputData.briefingId,
        sourceCount: allSources.length,
      };
    },
  });

  return createWorkflow({
    id: "ravendr-briefing",
    inputSchema,
    outputSchema,
  })
    .then(planStep)
    .then(searchStep)
    .then(synthesizeStep)
    .commit();
}

function stripCitationMarkers(md: string): string {
  return md
    .replace(/\[\[\s*\d+(?:\s*,\s*\d+)*\s*\]\]/g, "")
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mergeSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
