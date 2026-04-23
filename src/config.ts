import { z } from "zod";

/**
 * Two configs, one base shared:
 *   BaseConfig — what every service needs (Postgres + You.com + Mastra's
 *                Anthropic router + AssemblyAI, since the workflow task
 *                owns the AssemblyAI WebSocket now)
 *   WebConfig  — web service only (adds Render dispatch keys)
 */

const BaseSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  SERVICE_NAME: z.string().default("ravendr"),

  DATABASE_URL: z.string().url(),

  YOU_API_KEY: z.string().min(1),
  YOU_BASE_URL: z.string().url().default("https://api.you.com/v1"),

  // Mastra's model router reads ANTHROPIC_API_KEY directly from env.
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),

  // AssemblyAI is held by the voiceSession task (see src/render/tasks).
  ASSEMBLYAI_API_KEY: z.string().min(1),
  ASSEMBLYAI_AGENT_URL: z
    .string()
    .url()
    .default("wss://agents.assemblyai.com/v1/realtime"),
  ASSEMBLYAI_VOICE: z.string().default("claire"),
});

const WebSchema = BaseSchema.extend({
  RENDER_API_KEY: z.string().min(1),
  WORKFLOW_SLUG: z.string().default("ravendr-workflow"),
  RENDER_REGION: z.string().default("oregon"),

  // Public URL of THIS web service, used by the voiceSession task to open
  // its reverse WS back for audio tunneling.
  PUBLIC_WEB_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),

  // Session-management knobs. Ship with 100 cap per user's call; if we
  // blow through provider limits at load, tune down.
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(100),
  SESSION_LIFETIME_MINUTES: z.coerce.number().int().positive().default(15),
  /** Cleanup daemon tick (ms). 60s is fine; no reason to scan faster. */
  SESSION_PURGE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
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

export const loadConfig = loadWebConfig;
