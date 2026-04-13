import { task } from "@renderinc/sdk/workflows";
import { ask, parseJson } from "../lib/llm.js";
import { getAllKnowledge } from "../lib/db.js";
import type { KnowledgeEntry } from "../lib/db.js";

/**
 * Gathers all knowledge entries from the database.
 */
export const gather = task(
  {
    name: "gather",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 30,
    plan: "starter",
  },
  async function gather(): Promise<KnowledgeEntry[]> {
    return getAllKnowledge();
  }
);

/**
 * Groups knowledge entries into topic clusters using the LLM.
 */
export const cluster = task(
  {
    name: "cluster",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 1.5 },
    timeoutSeconds: 60,
    plan: "standard",
  },
  async function cluster(
    entries: KnowledgeEntry[]
  ): Promise<{ name: string; entryIds: string[] }[]> {
    if (entries.length === 0) return [];

    const entryList = entries
      .map((e) => `[${e.id}] ${e.topic}: ${e.content.slice(0, 100)}`)
      .join("\n");

    const clusters = await parseJson<{ name: string; entryIds: string[] }[]>(
      `Group these knowledge entries into logical topic clusters.

Entries:
${entryList}

Return a JSON array where each element has:
- name: a short cluster name
- entryIds: array of entry IDs belonging to this cluster

Entries can appear in multiple clusters if relevant. Return ONLY valid JSON wrapped in \`\`\`json code fences.`,
      "You are a knowledge organization assistant."
    );

    return clusters;
  }
);

/**
 * Finds connections across a single cluster of entries.
 */
export const crossReference = task(
  {
    name: "crossReference",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 60,
    plan: "starter",
  },
  async function crossReference(
    clusterName: string,
    entries: KnowledgeEntry[]
  ): Promise<{
    cluster: string;
    connections: string[];
    insights: string;
  }> {
    if (entries.length <= 1) {
      return {
        cluster: clusterName,
        connections: [],
        insights: `Only one entry in the "${clusterName}" cluster.`,
      };
    }

    const entryTexts = entries
      .map((e) => `[${e.topic}]: ${e.content.slice(0, 300)}`)
      .join("\n\n");

    const analysis = await ask(
      `Analyze the connections between these knowledge entries in the "${clusterName}" cluster:

${entryTexts}

Identify:
1. Key connections between entries
2. Emerging themes or patterns
3. Gaps in knowledge that could be explored

Be concise: 3-5 bullet points.`,
      "You are a knowledge analyst finding connections between topics."
    );

    return {
      cluster: clusterName,
      connections: entries.map((e) => e.id),
      insights: analysis,
    };
  }
);

interface ReportSection {
  cluster: string;
  insights: string;
  entryCount: number;
}

/**
 * Generates the final synthesis report from all cross-reference results.
 */
export const generateReport = task(
  {
    name: "generateReport",
    retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 1.5 },
    timeoutSeconds: 120,
    plan: "standard",
  },
  async function generateReport(
    crossRefResults: Awaited<ReturnType<typeof crossReference>>[],
    totalEntries: number
  ): Promise<{
    title: string;
    summary: string;
    sections: ReportSection[];
    gaps: string[];
    totalEntries: number;
    clusterCount: number;
  }> {
    const clusterSummaries = crossRefResults
      .map(
        (r) =>
          `## ${r.cluster}\n${r.insights}\nEntries: ${r.connections.length}`
      )
      .join("\n\n");

    const reportText = await ask(
      `Generate a knowledge base synthesis report based on these topic clusters:

${clusterSummaries}

Total entries: ${totalEntries}
Clusters: ${crossRefResults.length}

Write:
1. A title for this knowledge base report
2. A 2-3 sentence executive summary
3. Key knowledge gaps to explore next (as a list)

Be concise and insightful.`,
      "You are a knowledge analyst creating a synthesis report."
    );

    const titleMatch = reportText.match(/(?:title|#)\s*:?\s*(.+)/i);
    const title = titleMatch?.[1]?.trim() ?? "Knowledge Base Report";

    const gapSection = reportText.match(/gaps?.*?:\s*([\s\S]*?)(?:\n\n|$)/i);
    const gaps = gapSection
      ? gapSection[1]
          .split("\n")
          .map((l) => l.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean)
      : [];

    return {
      title,
      summary: reportText.slice(0, 500),
      sections: crossRefResults.map((r) => ({
        cluster: r.cluster,
        insights: r.insights,
        entryCount: r.connections.length,
      })),
      gaps,
      totalEntries,
      clusterCount: crossRefResults.length,
    };
  }
);

/**
 * Top-level report orchestrator: gather -> cluster -> crossReference (parallel) -> report.
 */
export const report = task(
  {
    name: "report",
    timeoutSeconds: 300,
    plan: "standard",
  },
  async function report(): Promise<{
    title: string;
    summary: string;
    sections: ReportSection[];
    gaps: string[];
    totalEntries: number;
    clusterCount: number;
  }> {
    const entries = await gather();

    if (entries.length === 0) {
      return {
        title: "Empty Knowledge Base",
        summary:
          "No knowledge entries found. Start a conversation to build your knowledge base.",
        sections: [],
        gaps: ["Start learning about topics to populate the knowledge base."],
        totalEntries: 0,
        clusterCount: 0,
      };
    }

    const clusters = await cluster(entries);

    const crossRefResults = await Promise.all(
      clusters.map((c) => {
        const clusterEntries = entries.filter((e) =>
          c.entryIds.includes(e.id)
        );
        return crossReference(c.name, clusterEntries);
      })
    );

    return generateReport(crossRefResults, entries.length);
  }
);
