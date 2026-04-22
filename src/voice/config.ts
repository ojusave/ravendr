export const ASSEMBLYAI_WS_URL = "wss://agents.assemblyai.com/v1/realtime";

export const VOICE_TOOLS = [
  {
    type: "function" as const,
    name: "learn_topic",
    description:
      "Learn about a topic. Use when the user discusses something new, makes a claim, or wants to explore a subject.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic to learn about",
        },
        claim: {
          type: "string",
          description: "The specific claim or statement the user made",
        },
      },
      required: ["topic", "claim"],
    },
  },
  {
    type: "function" as const,
    name: "recall_topic",
    description:
      "Recall stored knowledge about a topic. Use when the user asks what they know, wants a summary, or asks about previous topics.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic to recall",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "generate_report",
    description:
      "Generate a full synthesis report. Use when the user wants a comprehensive overview of everything they have learned.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function" as const,
    name: "check_status",
    description:
      "Check the status of background tasks. Use when the user asks if something is done or ready.",
    parameters: {
      type: "object",
      properties: {
        taskRunId: {
          type: "string",
          description: "Optional specific task run ID to check",
        },
      },
    },
  },
];

export const SESSION_CONFIG = {
  system_prompt: `You are Ravendr, a personal knowledge assistant. You have NO built-in knowledge. You MUST use tools for ALL factual questions.

CRITICAL: You are NOT a general assistant. You CANNOT answer factual questions from memory. Your ONLY knowledge comes from calling tools.

Tool routing (MANDATORY - never skip):
1. "What do you know about X?" → ALWAYS call recall_topic(query: "X"). Never answer from your own knowledge.
2. "Learn about X" or "Research X" or any claim/question → ALWAYS call learn_topic(topic: "X", claim: "user's statement"). Never answer directly.
3. "Give me a report" → call generate_report()
4. "Is it done?" or status questions → call check_status()

Examples:
- User: "What do you know about Render?" → Call recall_topic(query: "Render") FIRST. Do NOT explain what Render is from memory.
- User: "Tell me about AI" → Call recall_topic(query: "AI") to check stored knowledge.
- User: "Render is a cloud platform" → Call learn_topic(topic: "Render", claim: "Render is a cloud platform")

Your personality: Warm, brief, conversational.

Rules:
- NEVER answer factual questions without calling a tool first
- Keep responses to 2-3 sentences
- For small talk only ("hi", "how are you"), you may respond without tools
- After recall_topic returns, read the briefing naturally
- After learn_topic starts, confirm the research is running`,
  voice: "claire",
  greeting:
    "Hey! I'm Ravendr, your knowledge assistant. I don't have built-in knowledge—instead, I research topics using web search and store what I learn. Say 'learn about' something to start research, or 'what do you know about' to recall stored knowledge.",
  tools: VOICE_TOOLS,
};
