/**
 * Mastra agents drive LLM steps inside Render Workflow tasks.
 * You.com supplies web evidence; Mastra agents structure judgments and prose.
 */

import { z } from "zod";
import { factCheckerAgent } from "../agents/fact-checker.js";
import { connectorAgent } from "../agents/connector.js";
import { synthesizerAgent } from "../agents/synthesizer.js";
import type { KnowledgeEntry } from "./db.js";

const factCheckSchema = z.object({
  confidence: z.number().min(0).max(1),
  corrections: z.string(),
});

const connectSchema = z.object({
  content: z.string(),
  confidence: z.number().min(0).max(1),
  relatedEntryIds: z.array(z.string()).default([]),
});

export async function mastraFactCheckFromEvidence(
  topic: string,
  claim: string,
  searchEvidence: string
): Promise<{ confidence: number; corrections: string }> {
  const prompt = `Topic: "${topic}"
Claim to evaluate: "${claim}"

Web search evidence (You.com):
${searchEvidence.slice(0, 14_000)}

Assess whether the claim is accurate given the evidence. confidence is 0–1. corrections: empty string if accurate, otherwise brief fixes.`;

  const out = await factCheckerAgent.generate(prompt, {
    structuredOutput: { schema: factCheckSchema },
  });

  if (out.object) {
    return {
      confidence: out.object.confidence,
      corrections: out.object.corrections,
    };
  }

  return { confidence: 0.5, corrections: out.text?.slice(0, 500) ?? "" };
}

export async function mastraSynthesizeKnowledgeEntry(input: {
  topic: string;
  claim: string;
  factCheck: { confidence: number; corrections: string };
  deepSummary: string;
  existingLines: string;
}): Promise<z.infer<typeof connectSchema>> {
  const prompt = `Synthesize a single knowledge base entry for topic "${input.topic}" (user claim: "${input.claim}").

Fact-check (confidence ${input.factCheck.confidence}):
${input.factCheck.corrections || "No corrections."}

Deep research (You.com):
${input.deepSummary.slice(0, 12_000)}

Existing knowledge rows (ids matter for linking):
${input.existingLines || "None."}

Produce:
- content: 2–4 paragraphs, factual, suitable for storage
- confidence: your overall confidence 0–1 in this synthesis
- relatedEntryIds: ids of existing entries that strongly relate (subset of ids above, or empty)`;

  const out = await connectorAgent.generate(prompt, {
    structuredOutput: { schema: connectSchema },
  });

  if (out.object) {
    return {
      content: out.object.content,
      confidence: out.object.confidence,
      relatedEntryIds: out.object.relatedEntryIds ?? [],
    };
  }

  return {
    content: out.text ?? "",
    confidence: input.factCheck.confidence,
    relatedEntryIds: [],
  };
}

export async function mastraVoiceBriefing(input: {
  query: string;
  entries: KnowledgeEntry[];
  staleIds: string[];
  freshnessNotes: string;
}): Promise<{ briefing: string; entryCount: number; staleCount: number }> {
  if (input.entries.length === 0) {
    return {
      briefing: `I don't have any knowledge stored about "${input.query}" yet. Would you like me to research it?`,
      entryCount: 0,
      staleCount: 0,
    };
  }

  const entryTexts = input.entries
    .map((e) => {
      const staleTag = input.staleIds.includes(e.id) ? " [OUTDATED]" : "";
      return `Topic: ${e.topic}${staleTag}\n${e.content.slice(0, 500)}`;
    })
    .join("\n\n---\n\n");

  const prompt = `The user asked what they know about: "${input.query}"

Knowledge entries:
${entryTexts}

Freshness notes: ${input.freshnessNotes}

Write a concise voice briefing: 3–5 sentences, natural speech, mention outdated info if any.`;

  const out = await synthesizerAgent.generate(prompt);
  const briefing = out.text?.trim() ?? "";

  return {
    briefing,
    entryCount: input.entries.length,
    staleCount: input.staleIds.length,
  };
}
