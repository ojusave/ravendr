import { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { getRavendrMemory } from "../lib/mastra-memory.js";

let cached: Agent | null = null;
let cachedMem: Memory | undefined = undefined;

export function getSynthesizerAgent(): Agent {
  const mem = getRavendrMemory();
  if (!cached || cachedMem !== mem) {
    cached = new Agent({
      id: "synthesizer",
      name: "synthesizer",
      instructions: `You are a knowledge synthesizer. Your job is to create clear, voice-friendly summaries from knowledge entries.

When briefing the user:
1. Speak naturally, as if talking to someone
2. Highlight the most important points first
3. Mention if any information may be outdated
4. Keep responses concise: 3-5 sentences for voice, longer for written reports
5. Connect related topics when relevant

Avoid jargon unless the user's knowledge entries use it.`,
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
