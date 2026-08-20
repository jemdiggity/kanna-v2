/**
 * A request the desktop answered with a reason, rather than a transport that
 * failed.
 *
 * The distinction matters to the app's connection state: a task input held
 * behind someone's unsent line at that terminal is an ordinary outcome of a
 * healthy, connected session, and treating it like a broken link puts the whole
 * app into its error state over one message. The reason is carried as data so
 * callers branch on it instead of matching the message text.
 */
export class ServerRefusalError extends Error {
  readonly reason: string | null;
  readonly status: number;

  constructor(message: string, reason: string | null, status: number) {
    super(message);
    this.name = "ServerRefusalError";
    this.reason = reason;
    this.status = status;
  }
}

/** The refusal reason for a logical message queued behind an unsent human line. */
export const INPUT_HELD_BY_DRAFT_REASON = "input_held_by_draft";

/** Whether this rejection is the desktop reporting a held task input. */
export function isInputHeldByDraft(error: unknown): boolean {
  return (
    error instanceof ServerRefusalError &&
    error.reason === INPUT_HELD_BY_DRAFT_REASON
  );
}

/** The `{ reason, message }` a Kanna failure body carries, when it is one. */
export function readServerRefusal(body: unknown): {
  reason: string | null;
  message: string | null;
} {
  if (!body || typeof body !== "object") {
    return { reason: null, message: null };
  }
  const record = body as { reason?: unknown; message?: unknown };
  return {
    reason: typeof record.reason === "string" && record.reason ? record.reason : null,
    message:
      typeof record.message === "string" && record.message ? record.message : null
  };
}
