import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface SynthesizerConfig {
  apiKey: string;
  model: string;
}

export interface Branch {
  angle: string;
  query: string;
  content: string;
}

const SYSTEM = `You synthesize spoken briefings for Ravendr.

You receive a topic and N research branches (each an angle + its findings).
Weave them into one spoken briefing.

Rules:
- Open with a surprising, specific fact in the first sentence. No generic
  setup or "In this briefing…".
- 3–5 short paragraphs. No bullet lists. No markdown headers.
- Natural speech, the way a podcast host would talk.
- Keep inline citation markers like [1, 2] from the branches verbatim —
  they'll be stripped for audio but surfaced as source cards on screen.
- Aim for under 4 minutes of spoken audio (~600 words).
- End with a one-sentence takeaway.`;

export async function synthesize(
  topic: string,
  branches: Branch[],
  config: SynthesizerConfig,
  signal?: AbortSignal
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey });

  const prompt = [
    `Topic: ${topic}`,
    ``,
    ...branches.flatMap((b, i) => [
      `--- Branch ${i + 1}: ${b.angle} ---`,
      `Query: ${b.query}`,
      b.content.slice(0, 6_000),
      ``,
    ]),
    `Synthesize the spoken briefing now.`,
  ].join("\n");

  try {
    const response = await client.messages.create(
      {
        model: config.model,
        max_tokens: 2_048,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      },
      { signal }
    );
    const first = response.content[0];
    return first && first.type === "text" ? first.text : "";
  } catch (err) {
    logger.error({ err }, "synthesizer failed");
    throw new AppError("UPSTREAM_LLM", "synthesizer LLM call failed", {
      cause: err,
    });
  }
}
