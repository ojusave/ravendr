/**
 * Mastra Memory on Postgres (same DATABASE_URL as the app).
 * Fails soft if DATABASE_URL is missing so workflow tasks can still run without memory tables.
 */

import { createHash } from "node:crypto";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import {
  RequestContext,
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
} from "@mastra/core/request-context";

export const RAVENDR_RESOURCE_ID = "ravendr";

let store: PostgresStore | null = null;
let memory: Memory | null = null;
let initPromise: Promise<void> | null = null;
let memoryDisabled = false;

export async function ensureMastraMemory(): Promise<void> {
  if (memoryDisabled) return;
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    memoryDisabled = true;
    return;
  }
  if (!initPromise) {
    initPromise = (async () => {
      try {
        store = new PostgresStore({
          id: "ravendr-mastra-store",
          connectionString: url,
        });
        await store.init();
        memory = new Memory({
          storage: store,
          options: {
            lastMessages: 10,
          },
        });
      } catch (e) {
        console.warn(
          "[mastra-memory] init failed, continuing without persisted memory:",
          e instanceof Error ? e.message : e
        );
        memoryDisabled = true;
        memory = null;
        store = null;
      }
    })();
  }
  await initPromise;
}

export function getRavendrMemory(): Memory | undefined {
  return memory ?? undefined;
}

/** Stable thread key for ingest (same topic+claim → same Mastra thread). */
export function threadKeyIngest(topic: string, claim: string): string {
  return `ingest-${createHash("sha256").update(`${topic}\0${claim}`).digest("hex").slice(0, 24)}`;
}

export function threadKeyRecall(query: string): string {
  return `recall-${createHash("sha256").update(query).digest("hex").slice(0, 24)}`;
}

export function buildMastraRequestContext(threadId: string): RequestContext {
  const rc = new RequestContext();
  rc.set(MASTRA_THREAD_ID_KEY, threadId);
  rc.set(MASTRA_RESOURCE_ID_KEY, RAVENDR_RESOURCE_ID);
  return rc;
}
