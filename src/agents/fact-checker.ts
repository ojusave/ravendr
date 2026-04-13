import { Agent } from "@mastra/core/agent";

export const factCheckerAgent = new Agent({
  id: "fact-checker",
  name: "fact-checker",
  instructions: `You are a fact-checking specialist. Your job is to evaluate claims for accuracy.

When given a claim and search results:
1. Compare the claim against the evidence
2. Assign a confidence score from 0 to 1
3. Note any corrections or nuances

Be precise, cite specific evidence, and avoid speculation.`,
  model: {
    id: "anthropic/claude-sonnet-4-20250514",
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
});
