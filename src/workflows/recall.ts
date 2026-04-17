import { task } from "@renderinc/sdk/workflows";
import { quickSearch } from "../lib/you-client.js";
import { ask } from "../lib/llm.js";
import { mastraVoiceBriefing } from "../lib/mastra-workflow.js";
import { ensureMastraMemory } from "../lib/mastra-memory.js";
import { searchKnowledge, markStale } from "../lib/db.js";
import type { KnowledgeEntry } from "../lib/db.js";

/**
 * Searches the knowledge base for entries matching the query.
 */
export const search = task(
  {
    name: "search",
    retry: { maxRetries: 1, waitDurationMs: 500, backoffScaling: 1.5 },
    timeoutSeconds: 30,
    plan: "starter",
  },
  async function search(query: string): Promise<KnowledgeEntry[]> {
    return searchKnowledge(query);
  }
);

/**
 * Checks if stored knowledge entries are still current using You.com lite search.
 * Marks outdated entries as stale.
 */
export const freshen = task(
  {
    name: "freshen",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 1.5 },
    timeoutSeconds: 60,
    plan: "starter",
  },
  async function freshen(
    query: string,
    entries: KnowledgeEntry[]
  ): Promise<{
    entries: KnowledgeEntry[];
    staleIds: string[];
    freshnessNotes: string;
  }> {
    if (entries.length === 0) {
      return { entries: [], staleIds: [], freshnessNotes: "No entries to check." };
    }

    const liveResult = await quickSearch(
      `Latest information about: ${query}`
    );

    const entrySummaries = entries
      .map(
        (e) =>
          `[${e.id}] "${e.topic}" (stored ${e.created_at}): ${e.content.slice(0, 200)}`
      )
      .join("\n\n");

    const analysis = await ask(
      `Compare these stored knowledge entries against the latest web information.

Stored entries:
${entrySummaries}

Latest web results:
${liveResult.content.slice(0, 2000)}

For each entry, determine if it is still accurate or if it has become outdated.
List the IDs of any stale entries as a comma-separated list on the first line.
Then provide a brief summary of what has changed.

Format:
STALE: id1, id2 (or STALE: none)
NOTES: brief summary of freshness status`,
      "You are a knowledge freshness checker. Be concise."
    );

    const staleMatch = analysis.match(/STALE:\s*(.*)/i);
    const notesMatch = analysis.match(/NOTES:\s*([\s\S]*)/i);

    const staleIds: string[] = [];
    if (staleMatch && staleMatch[1].trim().toLowerCase() !== "none") {
      const ids = staleMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => entries.some((e) => e.id === s));
      staleIds.push(...ids);
    }

    if (staleIds.length > 0) {
      await markStale(staleIds);
    }

    return {
      entries,
      staleIds,
      freshnessNotes: notesMatch?.[1]?.trim() ?? "Freshness check complete.",
    };
  }
);

/**
 * Synthesizes a voice-friendly summary of the recalled knowledge.
 */
export const synthesize = task(
  {
    name: "synthesize",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 60,
    plan: "starter",
  },
  async function synthesize(
    query: string,
    freshenResult: Awaited<ReturnType<typeof freshen>>
  ): Promise<{
    briefing: string;
    entryCount: number;
    staleCount: number;
  }> {
    await ensureMastraMemory();
    const { entries, staleIds, freshnessNotes } = freshenResult;

    if (entries.length === 0) {
      return {
        briefing: `I don't have any knowledge stored about "${query}" yet. Would you like me to research it?`,
        entryCount: 0,
        staleCount: 0,
      };
    }

    const out = await mastraVoiceBriefing({
      query,
      entries,
      staleIds,
      freshnessNotes,
    });

    return {
      briefing: out.briefing,
      entryCount: out.entryCount,
      staleCount: out.staleCount,
    };
  }
);

/**
 * Top-level recall orchestrator: search -> freshen -> synthesize.
 */
export const recall = task(
  {
    name: "recall",
    timeoutSeconds: 180,
    plan: "starter",
  },
  async function recall(query: string): Promise<{
    briefing: string;
    entryCount: number;
    staleCount: number;
  }> {
    await ensureMastraMemory();
    const entries = await search(query);
    const freshenResult = await freshen(query, entries);
    return synthesize(query, freshenResult);
  }
);
