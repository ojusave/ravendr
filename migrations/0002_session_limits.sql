-- Session lifecycle: TTL + task handle for cleanup + closed tracking.
-- Enables a concurrent-session cap + periodic cleanup daemon.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at   timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_run_id  text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS closed_at    timestamptz;

-- Partial index speeds up both "count active" and "find expired" scans.
CREATE INDEX IF NOT EXISTS sessions_active_expires_idx
  ON sessions (expires_at)
  WHERE closed_at IS NULL;
