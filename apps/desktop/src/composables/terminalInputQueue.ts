import type { StreamClient } from "@kanna/stream-client"

const INPUT_BATCH_WINDOW_MS = 8

export interface TerminalInputQueue {
  sendInputBytes(
    bytes: Uint8Array,
    config?: { immediate?: boolean; submissionBoundary?: boolean; controlInput?: boolean },
  ): Promise<void>
  flushQueuedInput(): Promise<void>
  clearPendingInputFlushTimer(): void
}

type SendTerminalInput = (
  taskId: string,
  dataB64: string,
  submissionBoundary?: boolean,
  controlInput?: boolean,
) => Promise<void>

interface PendingInputBatch {
  bytes: number[]
  sendTerminalInput: SendTerminalInput
  submissionBoundary: boolean
  controlInput: boolean
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
  sendTerminalInput?: SendTerminalInput
  getSendTerminalInput?: () => SendTerminalInput
}): TerminalInputQueue {
  let pendingInputFlushTimer: ReturnType<typeof setTimeout> | null = null
  let pendingInputBatches: PendingInputBatch[] = []
  let inputWriteChain: Promise<void> = Promise.resolve()
  let inputWriteInFlight = false

  const defaultSendTerminalInput: SendTerminalInput = async (
    taskId,
    dataB64,
    submissionBoundary,
    controlInput,
  ) => {
    if (params.sendTerminalInput) {
      if (controlInput) {
        await params.sendTerminalInput(taskId, dataB64, false, true)
      } else if (submissionBoundary) {
        await params.sendTerminalInput(taskId, dataB64, true)
      } else {
        await params.sendTerminalInput(taskId, dataB64)
      }
      return
    }
    if (!params.getTerminalStreamClient) {
      throw new Error("terminal input has no configured transport")
    }
    const client = await params.getTerminalStreamClient()
    if (controlInput) {
      client.sendTermInput(taskId, dataB64, false, true)
    } else if (submissionBoundary) {
      client.sendTermInput(taskId, dataB64, true)
    } else {
      client.sendTermInput(taskId, dataB64)
    }
  }

  async function sendInputBytesNow(
    bytes: Uint8Array,
    sendTerminalInput: SendTerminalInput,
    submissionBoundary: boolean,
    controlInput: boolean,
  ) {
    const dataB64 = bytesToBase64(bytes)
    if (controlInput) {
      await sendTerminalInput(params.sessionId, dataB64, false, true)
    } else if (submissionBoundary) {
      await sendTerminalInput(params.sessionId, dataB64, true)
    } else {
      await sendTerminalInput(params.sessionId, dataB64)
    }
  }

  function queueInputWrite(
    bytes: Uint8Array,
    sendTerminalInput: SendTerminalInput,
    submissionBoundary: boolean,
    controlInput: boolean,
  ): Promise<void> {
    const runWrite = async () => {
      inputWriteInFlight = true
      try {
        await sendInputBytesNow(bytes, sendTerminalInput, submissionBoundary, controlInput)
      } finally {
        inputWriteInFlight = false
      }
    }

    if (!inputWriteInFlight && pendingInputBatches.length === 0 && !pendingInputFlushTimer) {
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
    if (pendingInputBatches.length === 0) {
      return inputWriteChain
    }
    const batches = pendingInputBatches
    pendingInputBatches = []
    for (const batch of batches) {
      inputWriteChain = queueInputWrite(
        new Uint8Array(batch.bytes),
        batch.sendTerminalInput,
        batch.submissionBoundary,
        batch.controlInput,
      )
    }
    return inputWriteChain
  }

  function queueInputBytes(
    bytes: Uint8Array,
    sendTerminalInput: SendTerminalInput,
    submissionBoundary: boolean,
    controlInput: boolean,
  ): void {
    const lastBatch = pendingInputBatches.at(-1)
    if (
      lastBatch?.sendTerminalInput === sendTerminalInput
      && !lastBatch.submissionBoundary
      && !lastBatch.controlInput
      && !controlInput
    ) {
      lastBatch.bytes.push(...bytes)
      lastBatch.submissionBoundary = submissionBoundary
    } else {
      pendingInputBatches.push({
        bytes: Array.from(bytes),
        sendTerminalInput,
        submissionBoundary,
        controlInput,
      })
    }
    if (pendingInputFlushTimer) {
      return
    }
    pendingInputFlushTimer = setTimeout(() => {
      pendingInputFlushTimer = null
      void flushQueuedInput()
    }, INPUT_BATCH_WINDOW_MS)
  }

  async function sendInputBytes(
    bytes: Uint8Array,
    config?: { immediate?: boolean; submissionBoundary?: boolean; controlInput?: boolean },
  ) {
    // Resolve the transport before any await. A retained terminal may switch
    // policy while this write is batched or queued behind an acknowledgement;
    // those bytes must retain the authority under which xterm captured them.
    const sendTerminalInput = params.getSendTerminalInput?.() ?? defaultSendTerminalInput
    if (config?.immediate) {
      await flushQueuedInput()
      await queueInputWrite(
        bytes,
        sendTerminalInput,
        config.submissionBoundary ?? false,
        config.controlInput ?? false,
      )
      return
    }
    queueInputBytes(
      bytes,
      sendTerminalInput,
      config?.submissionBoundary ?? false,
      config?.controlInput ?? false,
    )
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
