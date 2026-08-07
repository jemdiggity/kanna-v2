import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * OpenCode keeps every conversation in one shared SQLite store rather than in
 * per-session files, so a test cannot read a transcript off disk the way the
 * Claude suite does. The CLI is the contract: `session list` says which session
 * belongs to which working directory, and `export` returns the conversation.
 */
export interface OpencodeSessionListing {
  id: string;
  directory: string;
  updated: number;
}

export interface OpencodeSessionExport {
  info?: { id?: string; directory?: string };
  messages?: Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
}

/**
 * A process's working directory is reported fully resolved by the kernel, which
 * is what OpenCode records — and fixture repos live under a symlinked temp
 * root, so a raw worktree path never matches.
 */
export function resolvedWorktreePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return join(realpathSync(dirname(path)), basename(path));
  }
}

/**
 * OpenCode scopes both `session list` and `export` to the *project* of the
 * working directory they run in — a session opened in a task worktree is
 * invisible from anywhere else — so every call here names the directory whose
 * sessions it is asking about.
 */
export async function listOpencodeSessions(cwd: string): Promise<OpencodeSessionListing[]> {
  const { stdout } = await run("opencode", ["session", "list", "--format", "json"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.directory !== "string") return [];
    return [{
      id: record.id,
      directory: record.directory,
      updated: typeof record.updated === "number" ? record.updated : 0,
    }];
  });
}

export async function exportOpencodeSession(
  sessionId: string,
  cwd: string,
): Promise<OpencodeSessionExport> {
  const { stdout } = await run("opencode", ["export", sessionId], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as OpencodeSessionExport;
}

/**
 * Every text part of a conversation, in order, as one string — optionally only
 * the turns of one role.
 *
 * The role filter matters for continuity: a prompt Kanna re-sends on the
 * destination puts the *user* half of a conversation back on its own, so only
 * the assistant's turns prove the history itself crossed.
 */
export function opencodeSessionText(
  session: OpencodeSessionExport,
  role?: "user" | "assistant",
): string {
  return (session.messages ?? [])
    .filter((message) => role === undefined || message.info?.role === role)
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export async function waitForOpencodeSessionInDirectory(
  worktreePath: string,
  timeoutMs = 180_000,
  pollMs = 1_000,
): Promise<string> {
  const resolved = resolvedWorktreePath(worktreePath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = (await listOpencodeSessions(worktreePath).catch(() => []))
      .filter((session) => session.directory === resolved)
      .sort((left, right) => right.updated - left.updated);
    if (matches[0]) return matches[0].id;
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting for an opencode session in ${resolved}`);
}

/** Waits until an assistant turn of `sessionId` contains `text`. */
export async function waitForOpencodeAssistantText(
  sessionId: string,
  cwd: string,
  text: string,
  timeoutMs = 180_000,
  pollMs = 1_000,
): Promise<OpencodeSessionExport> {
  const deadline = Date.now() + timeoutMs;
  let last: OpencodeSessionExport | null = null;
  while (Date.now() < deadline) {
    last = await exportOpencodeSession(sessionId, cwd).catch(() => null);
    if (last && opencodeSessionText(last, "assistant").includes(text)) return last;
    await sleep(pollMs);
  }
  throw new Error(
    `timed out waiting for an assistant turn of ${sessionId} containing ${JSON.stringify(text)}: `
    + `${last ? JSON.stringify(opencodeSessionText(last).slice(0, 800)) : "no export"}`,
  );
}

/** Waits until `sessionId` is keyed to `worktreePath`, the resume precondition. */
export async function waitForOpencodeSessionDirectory(
  sessionId: string,
  worktreePath: string,
  timeoutMs = 120_000,
  pollMs = 1_000,
): Promise<void> {
  const resolved = resolvedWorktreePath(worktreePath);
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = (await listOpencodeSessions(worktreePath).catch(() => []))
      .find((session) => session.id === sessionId)?.directory;
    if (last === resolved) return;
    await sleep(pollMs);
  }
  throw new Error(
    `timed out waiting for opencode session ${sessionId} to be keyed to ${resolved} (was ${last})`,
  );
}
