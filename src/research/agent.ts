import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { EventBus, ResearchProvider, ResearchSource } from "../shared/ports.js";
import { Tier } from "../shared/events.js";
import {
  addSources,
  completeBriefing,
  setSessionStatus,
} from "../render/db.js";
import { logger } from "../shared/logger.js";

/**
 * Mastra Agent for Ravendr's research loop.
 *
 * Runs inside the Render Workflow task (the durable envelope). The agent's
 * LLM decides when to call each tool; we keep the tool set tight so the path
 * is predictable for a demo but still driven by LLM reasoning rather than a
 * hardcoded pipeline.
 *
 * Tools (narration hooks + side effects):
 *   plan_queries   — the agent commits its plan; we emit plan.ready
 *   search_web     — one You.com call; emits youcom.call.started/completed
 *   write_briefing — agent commits its final briefing; emits agent.synthesizing
 *                    then briefing.ready, persists to Postgres
 */

export interface ResearchAgentDeps {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
  anthropicModel: string; // bare model id (e.g. "claude-sonnet-4-20250514") or already prefixed
  sessionId: string;
  briefingId: string;
}

const QuerySchema = z.object({
  query: z.string().min(4).describe("The actual search query."),
  tier: Tier.describe(
    '"lite" for quick facts / recency, "standard" for substantive, "deep" for complex claims.'
  ),
  angle: z
    .string()
    .min(2)
    .describe("Short human label e.g. 'history', 'mechanism', 'recent events'."),
});

const INSTRUCTIONS = `You are Ravendr's researcher. Given a topic the user spoke aloud, produce a 2-4 minute spoken briefing by following this exact sequence:

1. Call plan_queries ONCE with the topic and 3-5 diverse queries. Each query should target a DIFFERENT angle (history, mechanism, key actors, recent events, numerical data, contested claims). Tier guidance:
   - "lite" for quick factual lookups or recency checks
   - "standard" for substantive questions (default)
   - "deep" only for genuinely complex or contested claims

2. Call search_web once per planned query. Fire them in parallel. Do NOT retry failed searches. Do NOT call search_web more than once per distinct query.

3. Once you have the search results, write the spoken briefing:
   - Open with a SPECIFIC surprising fact in the first sentence. No generic "In this briefing…" openers.
   - 3-5 short paragraphs. No bullet lists. No markdown headers. Conversational, podcast-host tone.
   - Keep inline citations like [1, 2] — they'll be stripped for audio, sources surface on screen.
   - End with one sentence capturing the takeaway.
   - Aim for about 600 words (4 minutes spoken).

4. Call write_briefing with the briefing text and a deduplicated list of source URLs you used.

Do not skip steps. Do not re-plan. Do not call tools you weren't told to call.`;

export function createResearchAgent(deps: ResearchAgentDeps) {
  const { events, research, databaseUrl, sessionId, briefingId } = deps;

  const planQueries = createTool({
    id: "plan_queries",
    description:
      "Commit your research plan. Call this once at the start with the topic and your chosen 3-5 parallel queries. Returns an acknowledgement so you can proceed to search_web.",
    inputSchema: z.object({
      topic: z.string(),
      queries: z.array(QuerySchema).min(3).max(5),
    }),
    outputSchema: z.object({ acknowledged: z.literal(true) }),
    execute: async (input) => {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "plan.ready",
        queries: input.queries.map((q) => ({
          query: q.query,
          tier: q.tier,
          angle: q.angle,
        })),
      });
      return { acknowledged: true as const };
    },
  });

  const searchWeb = createTool({
    id: "search_web",
    description:
      "Run one research query via You.com. Returns synthesized content with inline citations plus a list of sources. Call once per planned query, in parallel is fine.",
    inputSchema: z.object({
      query: z.string(),
      tier: Tier,
      angle: z
        .string()
        .describe("The angle label from your plan — for narration."),
    }),
    outputSchema: z.object({
      content: z.string(),
      sources: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          snippet: z.string().optional(),
        })
      ),
    }),
    execute: async (input) => {
      const { query, tier } = input;
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "youcom.call.started",
        query,
        tier,
      });
      try {
        const r = await research.research({ query, tier });
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "youcom.call.completed",
          query,
          tier,
          sourceCount: r.sources.length,
          latencyMs: r.latencyMs,
        });
        return { content: r.content, sources: r.sources };
      } catch (err) {
        logger.warn({ err, query }, "search_web failed");
        return { content: "", sources: [] as ResearchSource[] };
      }
    },
  });

  const writeBriefing = createTool({
    id: "write_briefing",
    description:
      "Commit your final spoken briefing. Call this exactly once at the end, after all searches complete. Persists the briefing and its sources.",
    inputSchema: z.object({
      content: z
        .string()
        .min(200)
        .describe("The full spoken briefing text with inline citations."),
      sources: z
        .array(
          z.object({
            url: z.string(),
            title: z.string(),
            snippet: z.string().optional(),
          })
        )
        .describe("Deduplicated list of all sources cited in the briefing."),
    }),
    outputSchema: z.object({
      briefingId: z.string(),
      sourceCount: z.number(),
    }),
    execute: async (input) => {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "agent.synthesizing",
      });

      const cleanContent = stripCitationMarkers(input.content);
      const uniqueSources = dedupeSources(input.sources);

      await completeBriefing(databaseUrl, briefingId, cleanContent);
      await addSources(databaseUrl, briefingId, uniqueSources);
      await setSessionStatus(databaseUrl, sessionId, "complete");

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "briefing.ready",
        briefingId,
        sourceCount: uniqueSources.length,
      });

      return { briefingId, sourceCount: uniqueSources.length };
    },
  });

  return new Agent({
    id: `researcher-${sessionId}`,
    name: "Ravendr Researcher",
    instructions: INSTRUCTIONS,
    model: normalizeModelId(deps.anthropicModel),
    tools: { plan_queries: planQueries, search_web: searchWeb, write_briefing: writeBriefing },
  });
}

function normalizeModelId(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}

function stripCitationMarkers(md: string): string {
  return md
    .replace(/\[\[\s*\d+(?:\s*,\s*\d+)*\s*\]\]/g, "")
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dedupeSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
