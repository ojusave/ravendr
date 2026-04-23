import { Pool, type PoolClient } from "pg";
import type { PhaseEvent } from "../shared/events.js";
import type { ResearchSource } from "../shared/ports.js";
import { AppError } from "../shared/errors.js";

let pool: Pool | null = null;

export function getPool(connectionString: string): Pool {
  if (pool) return pool;
  pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {
    // pg swallows connection errors if the listener is missing.
  });
  return pool;
}

export async function withClient<T>(
  connectionString: string,
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool(connectionString).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── sessions ───────────────────────────────────────────────────────
export interface Session {
  id: string;
  topic: string | null;
  createdAt: Date;
  status: "open" | "researching" | "complete" | "error";
  expiresAt: Date | null;
  taskRunId: string | null;
  closedAt: Date | null;
}

export async function createSession(
  db: string,
  topic: string | null,
  lifetimeMinutes = 15
): Promise<Session> {
  return withClient(db, async (c) => {
    const res = await c.query<{
      id: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `INSERT INTO sessions (topic, status, expires_at)
       VALUES ($1, 'open', now() + ($2 || ' minutes')::interval)
       RETURNING id, created_at, expires_at`,
      [topic, String(lifetimeMinutes)]
    );
    const row = res.rows[0];
    if (!row) throw new AppError("DB", "failed to create session");
    return {
      id: row.id,
      topic,
      createdAt: row.created_at,
      status: "open",
      expiresAt: row.expires_at,
      taskRunId: null,
      closedAt: null,
    };
  });
}

/** Count sessions that have a dispatched task still running. */
export async function countActiveSessions(db: string): Promise<number> {
  return withClient(db, async (c) => {
    const res = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM sessions
       WHERE closed_at IS NULL
         AND task_run_id IS NOT NULL
         AND expires_at > now()`
    );
    return Number(res.rows[0]?.n ?? 0);
  });
}

export async function setSessionTaskRun(
  db: string,
  sessionId: string,
  taskRunId: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(`UPDATE sessions SET task_run_id = $1 WHERE id = $2`, [
      taskRunId,
      sessionId,
    ])
  );
}

export async function markSessionClosed(
  db: string,
  sessionId: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(
      `UPDATE sessions SET closed_at = now() WHERE id = $1 AND closed_at IS NULL`,
      [sessionId]
    )
  );
}

/** Sessions whose TTL has passed but that still have a running task. */
export async function listExpiredActiveSessions(
  db: string
): Promise<Array<{ id: string; taskRunId: string }>> {
  return withClient(db, async (c) => {
    const res = await c.query<{ id: string; task_run_id: string }>(
      `SELECT id, task_run_id FROM sessions
       WHERE closed_at IS NULL
         AND task_run_id IS NOT NULL
         AND expires_at <= now()
       LIMIT 50`
    );
    return res.rows.map((r) => ({ id: r.id, taskRunId: r.task_run_id }));
  });
}

export async function getSession(
  db: string,
  sessionId: string
): Promise<Session | null> {
  return withClient(db, async (c) => {
    const res = await c.query<{
      id: string;
      topic: string | null;
      status: Session["status"];
      created_at: Date;
      expires_at: Date | null;
      task_run_id: string | null;
      closed_at: Date | null;
    }>(
      `SELECT id, topic, status, created_at, expires_at, task_run_id, closed_at
       FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      topic: row.topic,
      createdAt: row.created_at,
      status: row.status,
      expiresAt: row.expires_at,
      taskRunId: row.task_run_id,
      closedAt: row.closed_at,
    };
  });
}

export async function setSessionTopic(
  db: string,
  sessionId: string,
  topic: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(`UPDATE sessions SET topic = $1 WHERE id = $2`, [topic, sessionId])
  );
}

export async function setSessionStatus(
  db: string,
  sessionId: string,
  status: Session["status"]
): Promise<void> {
  await withClient(db, (c) =>
    c.query(`UPDATE sessions SET status = $1 WHERE id = $2`, [status, sessionId])
  );
}

// ─── briefings ──────────────────────────────────────────────────────
export interface Briefing {
  id: string;
  sessionId: string;
  runId: string | null;
  topic: string;
  content: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function createBriefing(
  db: string,
  sessionId: string,
  topic: string,
  runId: string | null
): Promise<string> {
  return withClient(db, async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO briefings (session_id, topic, run_id) VALUES ($1, $2, $3) RETURNING id`,
      [sessionId, topic, runId]
    );
    const row = res.rows[0];
    if (!row) throw new AppError("DB", "failed to create briefing");
    return row.id;
  });
}

export async function completeBriefing(
  db: string,
  briefingId: string,
  content: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(
      `UPDATE briefings SET content = $1, completed_at = now() WHERE id = $2`,
      [content, briefingId]
    )
  );
}

export async function getBriefing(
  db: string,
  briefingId: string
): Promise<Briefing | null> {
  return withClient(db, async (c) => {
    const res = await c.query<{
      id: string;
      session_id: string;
      run_id: string | null;
      topic: string;
      content: string | null;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id, session_id, run_id, topic, content, created_at, completed_at
       FROM briefings WHERE id = $1`,
      [briefingId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      topic: row.topic,
      content: row.content,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  });
}

// ─── sources ────────────────────────────────────────────────────────
export async function addSources(
  db: string,
  briefingId: string,
  sources: ResearchSource[]
): Promise<void> {
  if (sources.length === 0) return;
  await withClient(db, async (c) => {
    const values = sources
      .map(
        (_, i) =>
          `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`
      )
      .join(",");
    const params: (string | null)[] = [briefingId];
    for (const s of sources) {
      params.push(s.url, s.title, s.snippet ?? null);
    }
    await c.query(
      `INSERT INTO sources (briefing_id, url, title, snippet) VALUES ${values}
       ON CONFLICT (briefing_id, url) DO NOTHING`,
      params
    );
  });
}

export async function listSources(
  db: string,
  briefingId: string
): Promise<ResearchSource[]> {
  return withClient(db, async (c) => {
    const res = await c.query<{ url: string; title: string; snippet: string | null }>(
      `SELECT url, title, snippet FROM sources WHERE briefing_id = $1 ORDER BY created_at ASC`,
      [briefingId]
    );
    return res.rows.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet ?? undefined,
    }));
  });
}

// ─── phase event log (audit trail) ──────────────────────────────────
export async function recordPhaseEvent(
  db: string,
  event: PhaseEvent
): Promise<void> {
  await withClient(db, (c) =>
    c.query(
      `INSERT INTO phase_events (session_id, kind, payload) VALUES ($1, $2, $3)`,
      [event.sessionId, event.kind, JSON.stringify(event)]
    )
  );
}

export async function listPhaseEvents(
  db: string,
  sessionId: string
): Promise<PhaseEvent[]> {
  return withClient(db, async (c) => {
    const res = await c.query<{ payload: PhaseEvent }>(
      `SELECT payload FROM phase_events WHERE session_id = $1 ORDER BY at ASC`,
      [sessionId]
    );
    return res.rows.map((r) => r.payload);
  });
}
