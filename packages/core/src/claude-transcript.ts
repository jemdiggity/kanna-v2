/**
 * Where the Claude CLI keeps a session transcript.
 *
 * Claude writes each session's JSONL transcript to
 * `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` — keyed by the session's
 * **working directory**, not by session id alone. `~/.claude/tasks/<session-id>`
 * is a different, session-keyed directory that holds only a lock file and a
 * highwatermark; it is not the conversation.
 *
 * Kanna's cross-machine task transfer depends on this layout twice over: the
 * source locates the transcript from the stage run's cwd, and the receiver has
 * to re-derive the slug for the *destination* worktree, because the destination
 * path exists only on the receiving machine. Keeping the derivation here means
 * both sides share one rule instead of two copies of folklore.
 *
 * The layout, and the slug rule below, are pinned against the real CLI by
 * `tests/cli-contract/tests/live/claude-transcript-location.test.ts`. That test
 * is the canary for the day Claude moves its files again.
 *
 * When the receiver side moves into Rust (`transfer_artifact.rs` computes the
 * destination directory itself — the sender must never name a path), that
 * implementation has to mirror this rule. Port
 * {@link CLAUDE_PROJECT_SLUG_FIXTURES} along with it so both languages assert
 * the same table rather than drifting apart.
 */

/**
 * Derive the `~/.claude/projects/<slug>` directory name for a working directory.
 *
 * Every character that is not ASCII alphanumeric becomes `-`, with no
 * collapsing of runs: `/Users/x/.kanna/repos/r` → `-Users-x--kanna-repos-r`
 * (the `/.` pair yields two dashes). Case is preserved.
 *
 * `cwd` must be the **resolved physical path** — Claude derives the slug from
 * `process.cwd()`, which has already followed symlinks. On macOS that turns
 * `/tmp/x` into `/private/tmp/x`, and the two slugs are different directories.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Absolute path of the transcript for `sessionId` as written by a Claude
 * session whose working directory was `cwd`.
 */
export function claudeTranscriptPath(opts: {
  homeDir: string;
  cwd: string;
  sessionId: string;
}): string {
  const home = opts.homeDir.replace(/\/+$/, "");
  return `${home}/.claude/projects/${claudeProjectSlug(opts.cwd)}/${opts.sessionId}.jsonl`;
}

export interface ClaudeProjectSlugFixture {
  cwd: string;
  slug: string;
  /** What this case exists to pin. */
  note: string;
}

/**
 * The slug cases asserted against the live CLI. The live contract test runs a
 * real session from each of these directories (under a temp root) and checks
 * that the transcript lands where {@link claudeProjectSlug} says it will; the
 * offline test checks the function alone, so a regression is caught in normal
 * CI even when no CLI is installed.
 */
export const CLAUDE_PROJECT_SLUG_FIXTURES: readonly ClaudeProjectSlugFixture[] = [
  {
    cwd: "/Users/x/.kanna/repos/kanna-7",
    slug: "-Users-x--kanna-repos-kanna-7",
    note: "the shape Kanna actually produces: leading / and a dot-directory yield two dashes; hyphens survive as hyphens",
  },
  {
    cwd: "/Users/x/.kanna/repos/kanna-7/.kanna-worktrees/task-31b7ba29",
    slug: "-Users-x--kanna-repos-kanna-7--kanna-worktrees-task-31b7ba29",
    note: "a task worktree — the path a transfer receiver re-keys a transcript to",
  },
  {
    cwd: "/tmp/a.b_c-d",
    slug: "-tmp-a-b-c-d",
    note: "dot, underscore and hyphen all render as a single hyphen each",
  },
  {
    cwd: "/tmp/a b@c+d~e",
    slug: "-tmp-a-b-c-d-e",
    note: "spaces and punctuation are non-alphanumeric like everything else",
  },
  {
    cwd: "/Users/X9/Repo2",
    slug: "-Users-X9-Repo2",
    note: "case and digits are preserved verbatim",
  },
] as const;
