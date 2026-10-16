/**
 * Errors returned to the assistant. Every error says what is wrong (`message`) and what to do
 * next (`hint`), so a worker can recover without guessing.
 */

export type ZykErrorCode =
  | "task_not_found"
  | "stale_lock"
  | "already_resolved"
  | "wrong_task_kind"
  | "result_invalid"
  | "invalid_argument"
  | "unknown_playbook";

export class ZykError extends Error {
  constructor(
    readonly code: ZykErrorCode,
    message: string,
    readonly hint: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ZykError";
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
