import type { StreamClient } from "@kanna/stream-client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  base64ToBytes,
  bytesToBase64,
  createTerminalInputQueue,
} from "./terminalInputQueue"

function fakeClient(sendTermInput = vi.fn()): StreamClient {
  return { sendTermInput } as unknown as StreamClient
}

describe("terminalInputQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("coalesces rapid keypress bytes into one frame after eight milliseconds", async () => {
    const sendTermInput = vi.fn()
    const queue = createTerminalInputQueue({
      sessionId: "task-1",
      getTerminalStreamClient: async () => fakeClient(sendTermInput),
    })

    void queue.sendInputBytes(new TextEncoder().encode("a"))
    void queue.sendInputBytes(new TextEncoder().encode("b"))
    void queue.sendInputBytes(new TextEncoder().encode("c"))

    await vi.advanceTimersByTimeAsync(7)
    expect(sendTermInput).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await queue.flushQueuedInput()

    expect(sendTermInput).toHaveBeenCalledTimes(1)
    expect(sendTermInput).toHaveBeenCalledWith("task-1", bytesToBase64(new TextEncoder().encode("abc")))
  })

  it("keeps a producer-declared submission boundary and starts a new batch after it", async () => {
    const sendTermInput = vi.fn()
    const queue = createTerminalInputQueue({
      sessionId: "task-boundary",
      getTerminalStreamClient: async () => fakeClient(sendTermInput),
    })

    void queue.sendInputBytes(new TextEncoder().encode("draft"))
    void queue.sendInputBytes(new TextEncoder().encode("\r"), {
      submissionBoundary: true,
    })
    void queue.sendInputBytes(new TextEncoder().encode("next"))
    await queue.flushQueuedInput()

    expect(sendTermInput).toHaveBeenNthCalledWith(
      1,
      "task-boundary",
      bytesToBase64(new TextEncoder().encode("draft\r")),
      true,
    )
    expect(sendTermInput).toHaveBeenNthCalledWith(
      2,
      "task-boundary",
      bytesToBase64(new TextEncoder().encode("next")),
    )
  })

  it("keeps producer-declared controls separate from draft batches", async () => {
    const sendTermInput = vi.fn()
    const queue = createTerminalInputQueue({
      sessionId: "task-control",
      getTerminalStreamClient: async () => fakeClient(sendTermInput),
    })

    void queue.sendInputBytes(new TextEncoder().encode("draft"))
    void queue.sendInputBytes(new TextEncoder().encode("\x1b[<65;1;1M"), {
      controlInput: true,
    })
    await queue.flushQueuedInput()

    expect(sendTermInput).toHaveBeenNthCalledWith(
      1,
      "task-control",
      bytesToBase64(new TextEncoder().encode("draft")),
    )
    expect(sendTermInput).toHaveBeenNthCalledWith(
      2,
      "task-control",
      bytesToBase64(new TextEncoder().encode("\x1b[<65;1;1M")),
      false,
      true,
    )
  })

  it("preserves Kitty and bracketed-paste bytes exactly", async () => {
    const frames: Uint8Array[] = []
    const sendTermInput = vi.fn((_taskId: string, dataB64: string) => {
      frames.push(base64ToBytes(dataB64))
    })
    const queue = createTerminalInputQueue({
      sessionId: "task-opaque",
      getTerminalStreamClient: async () => fakeClient(sendTermInput),
    })
    const payload = new TextEncoder().encode("\x1b[13;2u\x1b[200~line 1\n界\x1b[201~")

    void queue.sendInputBytes(payload)
    await vi.advanceTimersByTimeAsync(8)
    await queue.flushQueuedInput()

    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0])).toEqual(Array.from(payload))
  })

  it("routes operator input through the process-authenticated native transport", async () => {
    const sendTerminalInput = vi.fn<(_taskId: string, _dataB64: string) => Promise<void>>()
      .mockResolvedValue()
    const queue = createTerminalInputQueue({
      sessionId: "task-merge",
      sendTerminalInput,
    })
    const payload = new TextEncoder().encode("merge PR 992\r")

    await queue.sendInputBytes(payload, { immediate: true })

    expect(sendTerminalInput).toHaveBeenCalledOnce()
    expect(sendTerminalInput).toHaveBeenCalledWith("task-merge", bytesToBase64(payload))
  })

  it("flushes queued typing before an immediate terminal response", async () => {
    const sent: string[] = []
    const sendTermInput = vi.fn((_taskId: string, dataB64: string) => {
      sent.push(new TextDecoder().decode(base64ToBytes(dataB64)))
    })
    const queue = createTerminalInputQueue({
      sessionId: "task-order",
      getTerminalStreamClient: async () => fakeClient(sendTermInput),
    })

    void queue.sendInputBytes(new TextEncoder().encode("typing"))
    await queue.sendInputBytes(new TextEncoder().encode("\x1b]52;response\x07"), {
      immediate: true,
    })

    expect(sent).toEqual(["typing", "\x1b]52;response\x07"])
  })

  it("continues sending after one stream-client acquisition fails", async () => {
    const sendTermInput = vi.fn()
    const getTerminalStreamClient = vi
      .fn<() => Promise<StreamClient>>()
      .mockRejectedValueOnce(new Error("stream unavailable"))
      .mockResolvedValue(fakeClient(sendTermInput))
    const queue = createTerminalInputQueue({
      sessionId: "task-retry",
      getTerminalStreamClient,
    })

    void queue.sendInputBytes(new TextEncoder().encode("lost"))
    const failedFlush = queue.flushQueuedInput()
    await expect(failedFlush).rejects.toThrow("stream unavailable")

    void queue.sendInputBytes(new TextEncoder().encode("next"))
    await vi.advanceTimersByTimeAsync(8)
    await queue.flushQueuedInput()

    expect(sendTermInput).toHaveBeenCalledOnce()
    expect(sendTermInput).toHaveBeenCalledWith(
      "task-retry",
      bytesToBase64(new TextEncoder().encode("next")),
    )
  })
})
