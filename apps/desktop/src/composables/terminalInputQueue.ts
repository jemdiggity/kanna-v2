import type { StreamClient } from "@kanna/stream-client"

const INPUT_BATCH_WINDOW_MS = 8

export interface TerminalInputQueue {
  sendInputBytes(bytes: Uint8Array, config?: { immediate?: boolean }): Promise<void>
  flushQueuedInput(): Promise<void>
  clearPendingInputFlushTimer(): void
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function base64ToBytes(dataB64: string): Uint8Array {
  const binary = atob(dataB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function createTerminalInputQueue(params: {
  sessionId: string
  getTerminalStreamClient?: () => Promise<StreamClient>
  sendTerminalInput?: (taskId: string, dataB64: string) => Promise<void>
}): TerminalInputQueue {
  let pendingInputFlushTimer: ReturnType<typeof setTimeout> | null = null
  let pendingInputBytes: number[] = []
  let inputWriteChain: Promise<void> = Promise.resolve()
  let inputWriteInFlight = false

  async function sendInputBytesNow(bytes: Uint8Array) {
    const dataB64 = bytesToBase64(bytes)
    if (params.sendTerminalInput) {
      await params.sendTerminalInput(params.sessionId, dataB64)
      return
    }
    if (!params.getTerminalStreamClient) {
      throw new Error("terminal input has no configured transport")
    }
    const client = await params.getTerminalStreamClient()
    client.sendTermInput(params.sessionId, dataB64)
  }

  function queueInputWrite(bytes: Uint8Array): Promise<void> {
    const runWrite = async () => {
      inputWriteInFlight = true
      try {
        await sendInputBytesNow(bytes)
      } finally {
        inputWriteInFlight = false
      }
    }

    if (!inputWriteInFlight && pendingInputBytes.length === 0 && !pendingInputFlushTimer) {
      inputWriteChain = runWrite()
      return inputWriteChain
    }

    inputWriteChain = inputWriteChain
      .catch(() => {})
      .then(runWrite)
    return inputWriteChain
  }

  function flushQueuedInput(): Promise<void> {
    if (pendingInputFlushTimer) {
      clearTimeout(pendingInputFlushTimer)
      pendingInputFlushTimer = null
    }
    if (pendingInputBytes.length === 0) {
      return inputWriteChain
    }
    const bytes = new Uint8Array(pendingInputBytes)
    pendingInputBytes = []
    return queueInputWrite(bytes)
  }

  function queueInputBytes(bytes: Uint8Array): void {
    pendingInputBytes.push(...bytes)
    if (pendingInputFlushTimer) {
      return
    }
    pendingInputFlushTimer = setTimeout(() => {
      pendingInputFlushTimer = null
      void flushQueuedInput()
    }, INPUT_BATCH_WINDOW_MS)
  }

  async function sendInputBytes(bytes: Uint8Array, config?: { immediate?: boolean }) {
    if (config?.immediate) {
      await flushQueuedInput()
      await queueInputWrite(bytes)
      return
    }
    queueInputBytes(bytes)
  }

  function clearPendingInputFlushTimer(): void {
    if (pendingInputFlushTimer) {
      clearTimeout(pendingInputFlushTimer)
      pendingInputFlushTimer = null
    }
  }

  return {
    sendInputBytes,
    flushQueuedInput,
    clearPendingInputFlushTimer,
  }
}
