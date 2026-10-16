-- The lock token that resolved (completed/failed) a task. Lets a worker safely retry a
-- completion whose response it never received: same token → idempotent success.
ALTER TABLE tasks ADD COLUMN resolved_by_token uuid;
