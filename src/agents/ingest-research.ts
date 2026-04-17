import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { Memory } from "@mastra/memory";
import { z } from "zod";
import { quickSearch, deepResearch } from "../lib/you-client.js";
import { getRavendrMemory } from "../lib/mastra-memory.js";

const sourceSchema = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
});

export const quickSearchTool = createTool({
  id: "quick_search",
  description:
    "Fast lite web search for fact-checking. Call with a focused query about the claim or topic.",
  inputSchema: z.object({
    query: z.string().describe("Search query optimized for fact-checking"),
  }),
  outputSchema: z.object({
    content: z.string(),
    sources: z.array(sourceSchema),
  }),
  execute: async ({ query }) => {
    const r = await quickSearch(query);
    return { content: r.content, sources: r.sources };
  },
});

export const deepResearchTool = createTool({
  id: "deep_research",
  description:
    "Deeper web research for a full overview. Call after quick_search with a broader topic query.",
  inputSchema: z.object({
    query: z.string().describe("Comprehensive research query"),
  }),
  outputSchema: z.object({
    content: z.string(),
    sources: z.array(sourceSchema),
  }),
  execute: async ({ query }) => {
    const r = await deepResearch(query);
    return { content: r.content, sources: r.sources };
  },
});

let cached: Agent | null = null;
let cachedMem: Memory | undefined = undefined;

export function getIngestResearchAgent(): Agent {
  const mem = getRavendrMemory();
  if (!cached || cachedMem !== mem) {
    cached = new Agent({
      id: "ingest-research",
      name: "ingest-research",
      instructions: `You gather web evidence for a personal knowledge base.

You MUST call tools in order:
1. quick_search — use a query like: fact-check: {claim} regarding {topic}
2. deep_research — use a query like: comprehensive overview of: {topic}

After both tools return, reply with a single line: "Evidence gathered."`,
      model: {
        id: "anthropic/claude-sonnet-4-20250514",
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
      tools: {
        quick_search: quickSearchTool,
        deep_research: deepResearchTool,
      },
      ...(mem ? { memory: mem } : {}),
    });
    cachedMem = mem;
  }
  return cached;
}
