import { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { getRavendrMemory } from "../lib/mastra-memory.js";

let cached: Agent | null = null;
let cachedMem: Memory | undefined = undefined;

export function getConnectorAgent(): Agent {
  const mem = getRavendrMemory();
  if (!cached || cachedMem !== mem) {
    cached = new Agent({
      id: "connector",
      name: "connector",
      instructions: `You are a knowledge connection specialist. Your job is to find relationships between topics in a knowledge base.

When analyzing entries:
1. Identify shared concepts, causes, or effects
2. Find cross-domain connections that might not be obvious
3. Spot emerging patterns or themes
4. Identify gaps where further research would be valuable

Be specific about connections: explain why two topics are related, not just that they are.`,
      model: {
        id: "anthropic/claude-sonnet-4-20250514",
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
      ...(mem ? { memory: mem } : {}),
    });
    cachedMem = mem;
  }
  return cached;
}
