-- Engine support. Hatchet durable tasks replay from the start after a worker restart, so every
-- write they make must be idempotent.

-- Audit entries written from replayable code carry a dedupe key; a replay inserts nothing.
ALTER TABLE audit_log ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX audit_log_dedupe_uniq ON audit_log (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Monotonic step counter: current_step only moves forward, so a replay that re-enters earlier
-- steps does not rewind it.
ALTER TABLE instances ADD COLUMN step_seq integer NOT NULL DEFAULT 0;
ALTER TABLE instances ADD COLUMN error jsonb;
