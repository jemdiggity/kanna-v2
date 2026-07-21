import { ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTerminalLayoutController } from "./terminalLayout"
import { createTerminalRuntimeState } from "./terminalRuntimeState"
import {
  forwardTerminalRuntimeStatus,
  registerTerminalRuntimeStatusSink,
  subscribeTerminalRuntimeStatus,
} from "./terminalRuntimeStatusSink"

describe("terminal reconnect runtime status", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("settles a reconnect from the KSP-fed per-session status bus", async () => {
    vi.useFakeTimers()
    const controller = createTerminalLayoutController({
      sessionId: "task-1",
      instanceId: "terminal-1",
      state: createTerminalRuntimeState(),
      terminal: ref(null),
      fitAddon: { fit: vi.fn() } as never,
      options: { agentProvider: "claude" },
      getContainer: () => null,
      getTerminalStreamClient: vi.fn(),
    })
    let resolved = false
    const settling = controller.waitForReconnectRedrawSettle().then(() => {
      resolved = true
    })

    await forwardTerminalRuntimeStatus("other-task", "idle")
    await vi.advanceTimersByTimeAsync(200)
    expect(resolved).toBe(false)

    await forwardTerminalRuntimeStatus("task-1", "idle")
    await vi.advanceTimersByTimeAsync(199)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settling
    expect(resolved).toBe(true)
  })

  it("delivers one session status to the store sink and every session subscriber", async () => {
    const storeSink = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const unregisterStore = registerTerminalRuntimeStatusSink(storeSink)
    const unsubscribeFirst = subscribeTerminalRuntimeStatus("task-1", first)
    const unsubscribeSecond = subscribeTerminalRuntimeStatus("task-1", second)

    await forwardTerminalRuntimeStatus("task-1", "waiting")

    expect(storeSink).toHaveBeenCalledWith("task-1", "waiting")
    expect(first).toHaveBeenCalledWith("waiting")
    expect(second).toHaveBeenCalledWith("waiting")
    unregisterStore()
    unsubscribeFirst()
    unsubscribeSecond()
  })
})
