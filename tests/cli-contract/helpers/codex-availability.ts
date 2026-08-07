/**
 * "Can this machine's codex account actually run a turn?" — the runtime half of
 * the availability story that helpers/availability.ts cannot answer, because an
 * installed, executable binary says nothing about credits or auth.
 *
 * A pin that goes red because the developer is out of credits teaches everyone
 * to ignore the suite, so both modes below must SKIP. Codex reports both the
 * same way: it starts a thread, then ends the turn with `turn.failed`, and
 * exits 1. The distinguishing detail is the error message.
 */

export interface CodexJsonResult {
  exitCode: number;
  lines: Array<Record<string, unknown>>;
}

/**
 * Substrings captured verbatim from codex-cli 0.146.1 on 2026-08-08, not
 * guessed:
 *
 *   exhausted account
 *     {"type":"turn.failed","error":{"message":"You've hit your usage limit.
 *      Visit https://chatgpt.com/codex/settings/usage to purchase more credits
 *      or try again at 12:34 PM."}}
 *
 *   CODEX_HOME pointed at a directory with no auth.json
 *     {"type":"turn.failed","error":{"message":"unexpected status 401
 *      Unauthorized: Missing bearer or basic authentication in header, url:
 *      https://api.openai.com/v1/responses, ..."}}
 */
const CODEX_UNAVAILABLE_PATTERNS: Array<{ pattern: string; reason: string }> = [
  { pattern: "hit your usage limit", reason: "codex account is out of credits" },
  { pattern: "purchase more credits", reason: "codex account is out of credits" },
  { pattern: "401 Unauthorized", reason: "codex CLI is not authenticated" },
  {
    pattern: "Missing bearer or basic authentication",
    reason: "codex CLI is not authenticated",
  },
];

function messageOf(line: Record<string, unknown>): string {
  // `error` lines carry `message`; `turn.failed` nests it under `error`.
  const direct = line.message;
  if (typeof direct === "string") return direct;
  const error = line.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const nested = (error as Record<string, unknown>).message;
    if (typeof nested === "string") return nested;
  }
  return "";
}

/**
 * The skip reason when codex cannot run a turn, or null when the run's outcome
 * is codex's own answer and the pin should be judged on it. Returns the reason
 * rather than a boolean so a skipped pin says *why* in the report — "codex
 * account is out of credits" is actionable, "skipped" is not.
 */
export function codexUnavailableReason(result: CodexJsonResult): string | null {
  if (result.exitCode === 0) return null;
  for (const line of result.lines) {
    if (line.type !== "error" && line.type !== "turn.failed") continue;
    const message = messageOf(line);
    for (const { pattern, reason } of CODEX_UNAVAILABLE_PATTERNS) {
      if (message.includes(pattern)) return reason;
    }
  }
  return null;
}
