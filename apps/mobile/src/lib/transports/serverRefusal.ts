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
  /**
   * The desktop's own sentence, without the transport prefix `message` carries
   * for logs. A screen that has room for one line shows this one.
   */
  readonly detail: string | null;

  constructor(
    message: string,
    reason: string | null,
    status: number,
    detail: string | null = null
  ) {
    super(message);
    this.name = "ServerRefusalError";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
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

/**
 * A failure body is capped before it reaches a phone screen. The desktop's own
 * refusals are one sentence; anything longer came from something else.
 */
const MAX_SERVER_FAILURE_MESSAGE = 400;

function truncateFailureMessage(message: string): string {
  return message.length <= MAX_SERVER_FAILURE_MESSAGE
    ? message
    : `${message.slice(0, MAX_SERVER_FAILURE_MESSAGE - 1)}…`;
}

/**
 * The desktop's explanation for a failed request, read from the raw body.
 *
 * Kanna's structured refusals are JSON `{ reason, message }`, but most of the
 * server's handlers answer a refusal with axum's `(StatusCode, String)`, which
 * is `text/plain`. Reading only JSON dropped those on the floor: a repository
 * command that the desktop refused with a full explanation — which singleton it
 * could not resolve, and that nothing was created — reached the phone as a bare
 * `LAN request failed (503)`, which names nothing a person can act on.
 *
 * Markup is not an explanation. A proxy's HTML error page says nothing about
 * this desktop, so it is dropped rather than rendered.
 */
export function readServerFailureBody(body: string): {
  reason: string | null;
  message: string | null;
} {
  const trimmed = body.trim();
  if (!trimmed) {
    return { reason: null, message: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === "string") {
    const message = parsed.trim();
    return { reason: null, message: message ? truncateFailureMessage(message) : null };
  }
  if (parsed && typeof parsed === "object") {
    return readServerRefusal(parsed);
  }
  if (parsed !== undefined || trimmed.startsWith("<")) {
    return { reason: null, message: null };
  }
  return { reason: null, message: truncateFailureMessage(trimmed) };
}
