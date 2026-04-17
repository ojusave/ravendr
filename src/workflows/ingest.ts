import { task } from "@renderinc/sdk/workflows";
import { quickSearch, deepResearch } from "../lib/you-client.js";
import { mastraFactCheckFromEvidence, mastraSynthesizeKnowledgeEntry } from "../lib/mastra-workflow.js";
import {
  storeKnowledgeEntry,
  searchKnowledge,
  updateConnections,
} from "../lib/db.js";

/**
 * Quick fact-check using You.com lite search (~5s).
 * Returns a confidence score and any corrections.
 */
export const factCheck = task(
  {
    name: "factCheck",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 1.5 },
    timeoutSeconds: 30,
    plan: "starter",
  },
  async function factCheck(
    topic: string,
    claim: string
  ): Promise<{
    confidence: number;
    corrections: string;
    sources: { url: string; title: string; snippet: string }[];
  }> {
    const result = await quickSearch(
      `Fact check: ${claim} regarding ${topic}`
    );

    const analysis = await mastraFactCheckFromEvidence(
      topic,
      claim,
      result.content
    );

    return {
      confidence: analysis.confidence,
      corrections: analysis.corrections,
      sources: result.sources.slice(0, 5),
    };
  }
);

/**
 * Deep research on the topic using You.com deep search (~30s).
 * Returns an expanded knowledge summary with citations.
 */
export const deepDive = task(
  {
    name: "deepDive",
    retry: { maxRetries: 2, waitDurationMs: 3000, backoffScaling: 2 },
    timeoutSeconds: 120,
    plan: "standard",
  },
  async function deepDive(
    topic: string
  ): Promise<{
    summary: string;
    sources: { url: string; title: string; snippet: string }[];
  }> {
    const result = await deepResearch(
      `Comprehensive overview of: ${topic}. Include recent developments and key facts.`
    );

    return {
      summary: result.content,
      sources: result.sources.slice(0, 10),
    };
  }
);

/**
 * Cross-references new findings with existing knowledge to find connections.
 */
export const connect = task(
  {
    name: "connect",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 60,
    plan: "starter",
  },
  async function connect(
    topic: string,
    claim: string,
    factCheckResult: Awaited<ReturnType<typeof factCheck>>,
    deepDiveResult: Awaited<ReturnType<typeof deepDive>>
  ): Promise<{
    content: string;
    confidence: number;
    sources: { url: string; title: string; snippet: string }[];
    relatedEntryIds: string[];
  }> {
    const existing = await searchKnowledge(topic);

    const existingLines =
      existing.length > 0
        ? existing
            .map((e) => `- [${e.id}] ${e.topic}: ${e.content.slice(0, 200)}`)
            .join("\n")
        : "";

    const synthesized = await mastraSynthesizeKnowledgeEntry({
      topic,
      claim,
      factCheck: {
        confidence: factCheckResult.confidence,
        corrections: factCheckResult.corrections,
      },
      deepSummary: deepDiveResult.summary,
      existingLines,
    });

    const allowedIds = new Set(existing.map((e) => e.id));
    const relatedEntryIds = synthesized.relatedEntryIds.filter((id) =>
      allowedIds.has(id)
    );

    const allSources = [
      ...factCheckResult.sources,
      ...deepDiveResult.sources,
    ];
    const uniqueSources = allSources.filter(
      (s, i, arr) => arr.findIndex((x) => x.url === s.url) === i
    );

    return {
      content: synthesized.content,
      confidence: synthesized.confidence,
      sources: uniqueSources,
      relatedEntryIds,
    };
  }
);

/**
 * Stores the synthesized knowledge entry and updates connections.
 */
export const store = task(
  {
    name: "store",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 30,
    plan: "starter",
  },
  async function store(
    topic: string,
    connectResult: Awaited<ReturnType<typeof connect>>
  ): Promise<{ entryId: string }> {
    const entryId = await storeKnowledgeEntry({
      topic,
      content: connectResult.content,
      sources: connectResult.sources,
      confidence: connectResult.confidence,
      connections: connectResult.relatedEntryIds,
    });

    for (const relatedId of connectResult.relatedEntryIds) {
      const existing = await searchKnowledge(topic);
      const related = existing.find((e) => e.id === relatedId);
      if (related && !related.connections.includes(entryId)) {
        await updateConnections(relatedId, [
          ...related.connections,
          entryId,
        ]);
      }
    }

    return { entryId };
  }
);

/**
 * Top-level ingest orchestrator: runs factCheck + deepDive in parallel,
 * then connect, then store.
 */
export const ingest = task(
  {
    name: "ingest",
    timeoutSeconds: 300,
    plan: "starter",
  },
  async function ingest(
    topic: string,
    claim: string
  ): Promise<{ entryId: string; confidence: number }> {
    const [factCheckResult, deepDiveResult] = await Promise.all([
      factCheck(topic, claim),
      deepDive(topic),
    ]);

    const connectResult = await connect(
      topic,
      claim,
      factCheckResult,
      deepDiveResult
    );
    const storeResult = await store(topic, connectResult);

    return {
      entryId: storeResult.entryId,
      confidence: connectResult.confidence,
    };
  }
);
