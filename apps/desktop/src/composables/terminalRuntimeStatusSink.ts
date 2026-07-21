export type TerminalRuntimeStatusSink = (
  sessionId: string,
  status: string,
) => void | Promise<void>

let runtimeStatusSink: TerminalRuntimeStatusSink | null = null
const sessionSubscribers = new Map<string, Set<(status: string) => void | Promise<void>>>()

export function registerTerminalRuntimeStatusSink(sink: TerminalRuntimeStatusSink): () => void {
  runtimeStatusSink = sink
  return () => {
    if (runtimeStatusSink === sink) runtimeStatusSink = null
  }
}

export function subscribeTerminalRuntimeStatus(
  sessionId: string,
  subscriber: (status: string) => void | Promise<void>,
): () => void {
  const subscribers = sessionSubscribers.get(sessionId) ?? new Set()
  subscribers.add(subscriber)
  sessionSubscribers.set(sessionId, subscribers)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) sessionSubscribers.delete(sessionId)
  }
}

export async function forwardTerminalRuntimeStatus(
  sessionId: string,
  status: string,
): Promise<void> {
  const pending: Array<void | Promise<void>> = []
  if (runtimeStatusSink) pending.push(runtimeStatusSink(sessionId, status))
  for (const subscriber of sessionSubscribers.get(sessionId) ?? []) {
    pending.push(subscriber(status))
  }
  await Promise.all(pending)
}
