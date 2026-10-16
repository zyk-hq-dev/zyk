/**
 * Outbox for task-resolution events. The zyk DB is the source of truth; events only wake the
 * waiting `zyk-step` run. Events can be lost (publish failed after commit) or arrive before
 * the step run registered its wait, so resolved-but-unconsumed tasks are re-published until the
 * step run marks them consumed. Duplicate events are harmless: the step re-reads the DB.
 */

import type { Pool } from "../db/pool.js";

export type PublishResolved = (taskId: string) => Promise<void>;

/** Publishes now and records it. Errors are left to the republisher. */
export async function publishResolution(pool: Pool, publish: PublishResolved, taskId: string): Promise<void> {
  try {
    await publish(taskId);
    await pool.query("UPDATE tasks SET event_published_at = now() WHERE id = $1", [taskId]);
  } catch (err) {
    console.error(`[outbox] publish failed for task ${taskId}, will retry:`, (err as Error).message);
  }
}

/**
 * Re-publishes events for tasks of running instances that are resolved but not consumed:
 * never published (after `unpublishedGraceSeconds`) or published more than
 * `republishAfterSeconds` ago. Returns the task ids published.
 */
export async function republishPending(
  pool: Pool,
  publish: PublishResolved,
  opts: { unpublishedGraceSeconds?: number; republishAfterSeconds?: number; limit?: number } = {}
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT t.id FROM tasks t JOIN instances i ON i.id = t.instance_id
      WHERE t.status IN ('completed', 'failed', 'cancelled')
        AND t.consumed_at IS NULL
        AND i.status = 'running'
        AND ((t.event_published_at IS NULL AND t.updated_at < now() - make_interval(secs => $1))
             OR t.event_published_at < now() - make_interval(secs => $2))
      ORDER BY t.updated_at
      LIMIT $3`,
    [opts.unpublishedGraceSeconds ?? 5, opts.republishAfterSeconds ?? 30, opts.limit ?? 100]
  );
  const published: string[] = [];
  for (const { id } of rows) {
    try {
      await publish(id);
      await pool.query("UPDATE tasks SET event_published_at = now() WHERE id = $1", [id]);
      published.push(id);
    } catch (err) {
      console.error(`[outbox] republish failed for task ${id}:`, (err as Error).message);
    }
  }
  return published;
}
