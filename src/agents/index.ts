import { Agent } from "@mastra/core/agent";
import { factCheckerAgent } from "./fact-checker.js";
import { synthesizerAgent } from "./synthesizer.js";
import { connectorAgent } from "./connector.js";

export const supervisorAgent = new Agent({
  id: "ravendr-supervisor",
  name: "ravendr-supervisor",
  instructions: `You are Ravendr, a personal learning companion and knowledge base builder.

Your role:
- Help the user learn about topics through voice conversation
- Store, connect, and recall knowledge over time
- Fact-check claims and provide sourced information
- Generate synthesis reports across the user's knowledge base

When the user discusses a topic, use learn_topic to store it.
When the user asks what they know about something, use recall_topic.
When the user wants a comprehensive report, use generate_report.
When the user asks about workflow status, use check_status.

Be conversational and brief in voice responses. Think of yourself as a knowledgeable friend who remembers everything the user has discussed.`,
  model: {
    id: "anthropic/claude-sonnet-4-20250514",
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  agents: {
    factChecker: factCheckerAgent,
    synthesizer: synthesizerAgent,
    connector: connectorAgent,
  },
});

export { factCheckerAgent, synthesizerAgent, connectorAgent };
