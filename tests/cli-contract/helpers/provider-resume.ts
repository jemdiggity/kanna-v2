import { randomUUID } from "node:crypto";

export function createResumeNonce(provider: string): string {
  return `KANNA_${provider.toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
}

export function rememberPrompt(nonce: string): string {
  return `Remember this opaque token for the next turn: ${nonce}. Reply with exactly READY.`;
}

export function recallPrompt(): string {
  return "Return only the opaque token I asked you to remember in the previous turn.";
}

export function providerUnavailableReason(output: string): string | null {
  const patterns = [
    /binary not found/i,
    /not logged in/i,
    /please log ?in/i,
    /failed to authenticate/i,
    /invalid authentication credentials/i,
    /does not have access/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function extractCodexThreadId(
  lines: Array<Record<string, unknown>>,
): string {
  const event = lines.find((line) => line.type === "thread.started");
  if (typeof event?.thread_id !== "string" || event.thread_id.length === 0) {
    throw new Error("Codex did not emit a thread.started thread_id");
  }
  return event.thread_id;
}

export function extractOpenCodeSessionId(
  lines: Array<Record<string, unknown>>,
): string {
  const ids = new Set(
    lines
      .map((line) => line.sessionID)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (ids.size === 0) {
    throw new Error("OpenCode did not emit a sessionID");
  }
  if (ids.size > 1) {
    throw new Error(`multiple OpenCode session IDs emitted: ${[...ids].join(", ")}`);
  }
  return [...ids][0];
}

export function selectNewConversationId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string {
  const created = [...after].filter((id) => !before.has(id));
  if (created.length !== 1) {
    throw new Error(
      `expected one new Antigravity conversation, found ${created.length}`,
    );
  }
  return created[0];
}
