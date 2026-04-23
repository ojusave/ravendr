import { z } from "zod";

/**
 * Two configs, one base shared:
 *   BaseConfig — what every service needs (Postgres + You.com)
 *   WebConfig  — web service only (adds AssemblyAI, Render dispatcher)
 *
 * The workflow task loads BaseConfig; the web service loads WebConfig.
 */

const BaseSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  SERVICE_NAME: z.string().default("ravendr"),

  DATABASE_URL: z.string().url(),

  YOU_API_KEY: z.string().min(1),
  YOU_BASE_URL: z.string().url().default("https://api.you.com/v1"),

  // Mastra's agents drive plan + synthesize; their LLM is Anthropic via AI SDK.
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),
});

const WebSchema = BaseSchema.extend({
  ASSEMBLYAI_API_KEY: z.string().min(1),
  ASSEMBLYAI_AGENT_URL: z
    .string()
    .url()
    .default("wss://agents.assemblyai.com/v1/realtime"),
  ASSEMBLYAI_VOICE: z.string().default("claire"),

  RENDER_API_KEY: z.string().min(1),
  WORKFLOW_SLUG: z.string().default("ravendr-workflow"),
  RENDER_REGION: z.string().default("oregon"),
});

export type BaseConfig = z.infer<typeof BaseSchema>;
export type WebConfig = z.infer<typeof WebSchema>;
export type Config = WebConfig; // back-compat alias

function explainAndThrow(err: z.ZodError): never {
  const issues = err.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment config:\n${issues}`);
}

let cachedBase: BaseConfig | null = null;
let cachedWeb: WebConfig | null = null;

export function loadWorkflowConfig(
  env: NodeJS.ProcessEnv = process.env
): BaseConfig {
  if (cachedBase) return cachedBase;
  const parsed = BaseSchema.safeParse(env);
  if (!parsed.success) explainAndThrow(parsed.error);
  cachedBase = parsed.data;
  return parsed.data;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  if (cachedWeb) return cachedWeb;
  const parsed = WebSchema.safeParse(env);
  if (!parsed.success) explainAndThrow(parsed.error);
  cachedWeb = parsed.data;
  cachedBase = parsed.data;
  return parsed.data;
}

// Back-compat: old callers import loadConfig (returns WebConfig).
export const loadConfig = loadWebConfig;
