-- zyk v2 initial schema. See docs/v2-architecture.md §5.
-- Requires Postgres 13+ (gen_random_uuid() is built in).

-- ── Tenants and API keys ──────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key_hash    text NOT NULL UNIQUE,          -- sha256 of the key; the key itself is never stored
  key_prefix  text NOT NULL,                 -- first chars, to identify a key in listings
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ── Playbook catalog (global, not tenant-owned) ───────────────────────────────

CREATE TABLE playbook_versions (
  playbook_id    text NOT NULL,
  version        text NOT NULL,              -- semver
  manifest       jsonb NOT NULL,
  content_hash   text NOT NULL,              -- sha256 of the manifest; detects edits to a released version
  registered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playbook_id, version)
);

-- ── Instances ─────────────────────────────────────────────────────────────────

CREATE TABLE instances (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  playbook_id            text NOT NULL,
  playbook_version       text NOT NULL,
  customization_version  integer,             -- NULL = playbook defaults
  effective_config       jsonb NOT NULL,       -- resolved extension-point values, pinned at start
  input                  jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  current_step           text,
  outcome                text,                 -- playbook-defined end state, e.g. 'resolved', 'stale'
  hatchet_run_id         text,
  external_key           text,                 -- dedupe key from the trigger, e.g. mail Message-ID
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  FOREIGN KEY (playbook_id, playbook_version) REFERENCES playbook_versions (playbook_id, version),
  CHECK ((status = 'running') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX instances_external_key_uniq
  ON instances (tenant_id, playbook_id, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX instances_tenant_status_idx ON instances (tenant_id, status, created_at DESC);

-- ── Tasks ─────────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  instance_id           uuid NOT NULL REFERENCES instances(id),
  step_key              text NOT NULL,
  iteration             integer NOT NULL DEFAULT 0,   -- loop round; keeps replays idempotent
  kind                  text NOT NULL CHECK (kind IN ('system', 'user')),
  topic                 text NOT NULL,
  instructions          text NOT NULL,                -- from playbook/customization only
  input                 jsonb NOT NULL DEFAULT '{}',
  untrusted_content     jsonb,                        -- external text, data only; purged after retention
  untrusted_expires_at  timestamptz,
  result_schema         jsonb NOT NULL,
  allowed_tools         text[] NOT NULL DEFAULT '{}',
  idempotency_key       text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'locked', 'completed', 'failed', 'cancelled')),
  lock_token            uuid,
  locked_by             text,
  lock_expires_at       timestamptz,
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts          integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  due_at                timestamptz NOT NULL DEFAULT now(),
  result                jsonb,
  error                 jsonb,
  decided_via           text CHECK (decided_via IN ('conversation', 'elicitation', 'ui')),
  event_published_at    timestamptz,                  -- outbox: completion event sent to Hatchet
  consumed_at           timestamptz,                  -- step run has read the outcome and moved on
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  UNIQUE (instance_id, step_key, iteration),
  -- A lock exists exactly while the task is locked.
  CHECK ((status = 'locked') = (lock_token IS NOT NULL)),
  CHECK ((status = 'locked') = (lock_expires_at IS NOT NULL)),
  -- Only user tasks record how the decision was made.
  CHECK (decided_via IS NULL OR kind = 'user')
);
-- fetch_and_lock: due pending tasks per tenant
CREATE INDEX tasks_claim_idx ON tasks (tenant_id, due_at) WHERE status = 'pending';
-- reaper: expired leases
CREATE INDEX tasks_lease_idx ON tasks (lock_expires_at) WHERE status = 'locked';
-- outbox: resolved but not yet consumed by the step run
CREATE INDEX tasks_outbox_idx ON tasks (updated_at)
  WHERE status IN ('completed', 'failed', 'cancelled') AND consumed_at IS NULL;
CREATE INDEX tasks_instance_idx ON tasks (instance_id);
CREATE INDEX tasks_untrusted_expiry_idx ON tasks (untrusted_expires_at)
  WHERE untrusted_content IS NOT NULL;

-- ── Audit log (append-only) ───────────────────────────────────────────────────

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  instance_id  uuid REFERENCES instances(id),
  task_id      uuid REFERENCES tasks(id),
  actor_type   text NOT NULL
               CHECK (actor_type IN ('worker', 'user', 'reaper', 'webhook', 'engine', 'admin')),
  actor_id     text,
  event        text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_instance_idx ON audit_log (instance_id, id);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
