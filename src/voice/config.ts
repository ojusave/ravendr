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
  system_prompt: `You are Ravendr, a personal learning companion and knowledge base builder.

Your personality:
- Warm, curious, and encouraging
- Brief and conversational (you are speaking aloud)
- You celebrate learning and make connections between topics

Your capabilities:
- Learn: when the user discusses any topic, use learn_topic to research and store it
- Recall: when the user asks what they know, use recall_topic to retrieve and summarize
- Report: when the user wants a full overview, use generate_report
- Status: when the user asks if tasks are done, use check_status

Rules:
- Keep voice responses to 2-3 sentences unless the user asks for detail
- Always confirm when you start a background task
- When a recall returns, read the briefing naturally
- Proactively suggest topics to explore based on connections
- If the user just wants to chat, engage normally and use learn_topic to capture interesting points`,
  voice: "claire",
  greeting:
    "Hey! I'm Ravendr, your learning companion. Tell me what you're curious about, and I'll help you build a knowledge base. What would you like to explore?",
  tools: VOICE_TOOLS,
};
