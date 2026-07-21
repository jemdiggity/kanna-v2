export type TerminalRuntimeStatusSink = (
  sessionId: string,
  status: string,
) => void | Promise<void>

let runtimeStatusSink: TerminalRuntimeStatusSink | null = null

export function registerTerminalRuntimeStatusSink(sink: TerminalRuntimeStatusSink): () => void {
  runtimeStatusSink = sink
  return () => {
    if (runtimeStatusSink === sink) runtimeStatusSink = null
  }
}

export async function forwardTerminalRuntimeStatus(
  sessionId: string,
  status: string,
): Promise<void> {
  await runtimeStatusSink?.(sessionId, status)
}
