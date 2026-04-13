import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      sources JSONB DEFAULT '[]',
      confidence FLOAT DEFAULT 0.5,
      connections UUID[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      stale BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      input JSONB,
      result JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  sources: { url: string; title: string; snippet: string }[];
  confidence: number;
  connections: string[];
  created_at: string;
  updated_at: string;
  stale: boolean;
}

export interface WorkflowRun {
  id: string;
  type: "ingest" | "recall" | "report";
  status: "running" | "completed" | "failed";
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
}

export async function storeKnowledgeEntry(entry: {
  topic: string;
  content: string;
  sources: { url: string; title: string; snippet: string }[];
  confidence: number;
  connections: string[];
}): Promise<string> {
  const res = await pool.query(
    `INSERT INTO knowledge_entries (topic, content, sources, confidence, connections)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      entry.topic,
      entry.content,
      JSON.stringify(entry.sources),
      entry.confidence,
      entry.connections,
    ]
  );
  return res.rows[0].id;
}

export async function searchKnowledge(
  query: string
): Promise<KnowledgeEntry[]> {
  const res = await pool.query(
    `SELECT * FROM knowledge_entries
     WHERE topic ILIKE $1 OR content ILIKE $1
     ORDER BY updated_at DESC
     LIMIT 20`,
    [`%${query}%`]
  );
  return res.rows;
}

export async function getAllKnowledge(): Promise<KnowledgeEntry[]> {
  const res = await pool.query(
    `SELECT * FROM knowledge_entries ORDER BY created_at DESC`
  );
  return res.rows;
}

export async function markStale(ids: string[]) {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE knowledge_entries SET stale = TRUE, updated_at = now() WHERE id = ANY($1)`,
    [ids]
  );
}

export async function updateConnections(
  id: string,
  connections: string[]
) {
  await pool.query(
    `UPDATE knowledge_entries SET connections = $2, updated_at = now() WHERE id = $1`,
    [id, connections]
  );
}

export async function trackWorkflowRun(run: {
  id: string;
  type: WorkflowRun["type"];
  input: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO workflow_runs (id, type, status, input)
     VALUES ($1, $2, 'running', $3)
     ON CONFLICT (id) DO NOTHING`,
    [run.id, run.type, JSON.stringify(run.input)]
  );
}

export async function completeWorkflowRun(
  id: string,
  result: Record<string, unknown>
) {
  await pool.query(
    `UPDATE workflow_runs SET status = 'completed', result = $2 WHERE id = $1`,
    [id, JSON.stringify(result)]
  );
}

export async function failWorkflowRun(id: string, error: string) {
  await pool.query(
    `UPDATE workflow_runs SET status = 'failed', result = $2 WHERE id = $1`,
    [id, JSON.stringify({ error })]
  );
}

export async function getRecentWorkflowRuns(
  limit = 10
): Promise<WorkflowRun[]> {
  const res = await pool.query(
    `SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export { pool };
