import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";

export async function ask(prompt: string, systemPrompt?: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt ?? "You are a helpful assistant.",
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

export async function parseJson<T>(
  prompt: string,
  systemPrompt?: string
): Promise<T> {
  const text = await ask(prompt, systemPrompt);

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();

  return JSON.parse(raw) as T;
}
