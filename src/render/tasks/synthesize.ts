import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { addSources, completeBriefing, setSessionStatus } from "../db.js";
import { synthesizerAgent } from "../../mastra/agents.js";
import type { BranchResult } from "./search-branch.js";

export interface SynthesizeResult {
  briefingId: string;
  sourceCount: number;
  content: string;
}

export const synthesize = task(
  {
    name: "synthesize",
    plan: "starter",
    timeoutSeconds: 120,
    retry: { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function synthesize(
    sessionId: string,
    briefingId: string,
    topic: string,
    branches: BranchResult[]
  ): Promise<SynthesizeResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "agent.synthesizing",
      });

      const usable = branches.filter((b) => b.content.trim().length > 0);
      if (usable.length === 0) {
        throw new Error("all research branches returned empty content");
      }

      const prompt = [
        `Topic: ${topic}`,
        ``,
        ...usable.flatMap((b, i) => [
          `--- Branch ${i + 1}: ${b.angle} ---`,
          `Query: ${b.query}`,
          b.content.slice(0, 6_000),
          ``,
        ]),
        `Synthesize the spoken briefing now.`,
      ].join("\n");

      const agent = synthesizerAgent(config.ANTHROPIC_MODEL);
      const result = await agent.generate(prompt);
      const raw = (result as { text?: string }).text ?? "";
      const content = stripCitationMarkers(raw).trim();

      const uniqueSources = dedupeSources(usable.flatMap((b) => b.sources));

      await completeBriefing(config.DATABASE_URL, briefingId, content);
      await addSources(config.DATABASE_URL, briefingId, uniqueSources);
      // NOTE: briefing.ready is NOT published here. The research root task
      // publishes it ONCE, after the verify+retry loop has settled, so the
      // UI never flashes a rejected briefing and the voice agent reads only
      // the final version.

      return { briefingId, sourceCount: uniqueSources.length, content };
    } finally {
      await events.stop();
    }
  }
);

function stripCitationMarkers(md: string): string {
  return md
    .replace(/\[\[\s*\d+(?:\s*,\s*\d+)*\s*\]\]/g, "")
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dedupeSources(
  sources: { url: string; title: string; snippet?: string }[]
): { url: string; title: string; snippet?: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title: string; snippet?: string }[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
