export interface TaskSessionIdentity {
  id: string;
  branch?: string | null;
}

export function resolveTaskItemForDaemonSession<T extends TaskSessionIdentity>(
  items: readonly T[],
  sessionId: string,
): T | null {
  return items.find((candidate) => candidate.id === sessionId)
    ?? items.find((candidate) => candidate.branch === sessionId)
    ?? null;
}
