import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  SERVICE_NAME: z.string().default("ravendr-web"),

  DATABASE_URL: z.string().url(),

  YOUCOM_API_KEY: z.string().min(1),
  YOUCOM_BASE_URL: z.string().url().default("https://api.you.com/v1"),

  ASSEMBLYAI_API_KEY: z.string().min(1),
  ASSEMBLYAI_AGENT_URL: z
    .string()
    .url()
    .default("wss://agents.assemblyai.com/v1/realtime"),
  ASSEMBLYAI_VOICE: z.string().default("claire"),

  RENDER_API_KEY: z.string().min(1),
  WORKFLOW_SLUG: z.string().default("ravendr-tasks"),
  RENDER_REGION: z.string().default("oregon"),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment config:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
