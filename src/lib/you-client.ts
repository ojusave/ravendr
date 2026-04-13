import { You } from "@youdotcom-oss/sdk";

const you = new You({
  apiKeyAuth: process.env.YOU_API_KEY ?? "",
});

export type ResearchEffort = "lite" | "standard" | "deep" | "exhaustive";

export interface ResearchResult {
  content: string;
  sources: { url: string; title: string; snippet: string }[];
}

export async function research(
  query: string,
  effort: ResearchEffort = "standard"
): Promise<ResearchResult> {
  const result = await you.research({
    input: query,
    researchEffort: effort,
  });

  const output = result.output as {
    content?: string;
    sources?: { url?: string; title?: string; snippet?: string }[];
  };

  return {
    content: output.content ?? "",
    sources: (output.sources ?? []).map((s) => ({
      url: s.url ?? "",
      title: s.title ?? "",
      snippet: s.snippet ?? "",
    })),
  };
}

export async function quickSearch(query: string): Promise<ResearchResult> {
  return research(query, "lite");
}

export async function deepResearch(query: string): Promise<ResearchResult> {
  return research(query, "deep");
}
