import { task } from "@renderinc/sdk/workflows";
import { quickSearch, deepResearch } from "../lib/you-client.js";
import {
  mastraFactCheckFromEvidence,
  mastraSynthesizeKnowledgeEntry,
  runResearchPhaseWithMastraTools,
} from "../lib/mastra-workflow.js";
import {
  ensureMastraMemory,
  buildMastraRequestContext,
  threadKeyIngest,
} from "../lib/mastra-memory.js";
import {
  storeKnowledgeEntry,
  searchKnowledge,
  updateConnections,
} from "../lib/db.js";

/**
 * Quick fact-check using You.com lite search (~5s).
 * Kept as a standalone task for retries / manual runs.
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
    await ensureMastraMemory();
    const result = await quickSearch(
      `Fact check: ${claim} regarding ${topic}`
    );
    const rc = buildMastraRequestContext(threadKeyIngest(topic, claim));

    const analysis = await mastraFactCheckFromEvidence(
      topic,
      claim,
      result.content,
      rc
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
    deepDiveResult: Awaited<ReturnType<typeof deepDive>>,
    threadId: string
  ): Promise<{
    content: string;
    confidence: number;
    sources: { url: string; title: string; snippet: string }[];
    relatedEntryIds: string[];
  }> {
    await ensureMastraMemory();
    const rc = buildMastraRequestContext(threadId);

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
      rc,
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
 * Top-level ingest: Mastra tool agent (You.com) + fact-check + connect + store.
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
    await ensureMastraMemory();
    const threadId = threadKeyIngest(topic, claim);

    const bundle = await runResearchPhaseWithMastraTools(topic, claim);
    const rc = buildMastraRequestContext(threadId);

    const fc = await mastraFactCheckFromEvidence(
      topic,
      claim,
      bundle.quickContent,
      rc
    );

    const factCheckResult = {
      confidence: fc.confidence,
      corrections: fc.corrections,
      sources: bundle.quickSources.slice(0, 5),
    };

    const deepDiveResult = {
      summary: bundle.deepSummary,
      sources: bundle.deepSources.slice(0, 10),
    };

    const connectResult = await connect(
      topic,
      claim,
      factCheckResult,
      deepDiveResult,
      threadId
    );
    const storeResult = await store(topic, connectResult);

    return {
      entryId: storeResult.entryId,
      confidence: connectResult.confidence,
    };
  }
);
