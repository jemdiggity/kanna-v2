import type { Ref } from "vue"
import type { Terminal } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import type { StreamClient } from "@kanna/stream-client"
import { nextFrameOrTimeout } from "../utils/animationFrame"
import { subscribeTerminalRuntimeStatus } from "./terminalRuntimeStatusSink"
import {
  getReconnectRedrawPolicy,
  getReconnectResizeDelayMs,
} from "./terminalSessionRecovery"
import type { TerminalRuntimeState } from "./terminalRuntimeState"
import type { TerminalOptions } from "./terminalTypes"

export interface TerminalLayoutController {
  ensureFitted(): Promise<void>
  waitForReconnectRedrawSettle(): Promise<void>
  waitForReconnectResizeDelay(): Promise<void>
  resizeLiveSession(cols: number, rows: number, forceDouble: boolean): Promise<void>
  fit(): void
  fitDeferred(): void
  cancelPendingFit(): void
}

function isScrolledToBottom(term: Terminal) {
  const activeBuffer = term.buffer.active
  return activeBuffer.viewportY >= activeBuffer.baseY
}

export function createTerminalLayoutController(params: {
  sessionId: string
  instanceId: string
  state: TerminalRuntimeState
  terminal: Ref<Terminal | null>
  fitAddon: FitAddon
  options?: TerminalOptions
  getContainer: () => HTMLElement | null
  getTerminalStreamClient: () => Promise<StreamClient>
}): TerminalLayoutController {
  /** Wait for a settled visible container, then fit the terminal. */
  async function ensureFitted() {
    let lastWidth = -1
    let lastHeight = -1
    // A task slot can be mounted while its flex layout is still changing. Two
    // consecutive measurements prevent the first viewer registration from
    // publishing xterm's default grid (or an intermediate zero-sized grid).
    // The bound also covers occluded WKWebView windows where rAF stops ticking.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const container = params.getContainer()
      const width = container?.offsetWidth ?? 0
      const height = container?.offsetHeight ?? 0
      const proposal = width > 0 && height > 0
        ? params.fitAddon.proposeDimensions?.()
        : undefined
      if (
        width > 0 &&
        height > 0 &&
        width === lastWidth &&
        height === lastHeight &&
        proposal &&
        proposal.cols > 0 &&
        proposal.rows > 0
      ) {
        params.fitAddon.fit()
        return
      }
      lastWidth = width
      lastHeight = height
      await nextFrameOrTimeout()
    }

    const settledContainer = params.getContainer()
    if (
      settledContainer &&
      settledContainer.offsetWidth > 0 &&
      settledContainer.offsetHeight > 0 &&
      params.fitAddon.proposeDimensions?.()
    ) {
      params.fitAddon.fit()
    }
  }

  async function waitForReconnectRedrawSettle() {
    const policy = getReconnectRedrawPolicy(params.options)
    if (!policy.waitForIdleStatus) return

    await new Promise<void>((resolve) => {
      let settled = false
      let stopListening: (() => void) | null = null

      const finish = (delayMs: number) => {
        if (settled) return
        settled = true
        stopListening?.()
        setTimeout(resolve, delayMs)
      }

      const fallback = setTimeout(() => finish(0), policy.fallbackDelayMs)
      const completeFromIdle = () => {
        clearTimeout(fallback)
        finish(policy.settleDelayMs)
      }

      stopListening = subscribeTerminalRuntimeStatus(params.sessionId, (status) => {
        if (status === policy.waitForIdleStatus) {
          completeFromIdle()
        }
      })
    })
  }

  async function waitForReconnectResizeDelay() {
    const delayMs = getReconnectResizeDelayMs(params.options)
    if (delayMs <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  }

  async function resizeLiveSession(cols: number, rows: number, forceDouble: boolean) {
    const client = await params.getTerminalStreamClient()
    if (forceDouble) {
      const shrinkCols = Math.max(1, cols - 1)
      console.warn("[terminal][connect] resize:double", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        cols,
        rows,
      })
      client.sendTermResize(params.sessionId, shrinkCols, rows)
      client.sendTermResize(params.sessionId, cols, rows)
      return
    }

    console.warn("[terminal][connect] resize:single", {
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      cols,
      rows,
    })
    client.sendTermResize(params.sessionId, cols, rows)
  }

  function fit() {
    const container = params.getContainer()
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return
    const liveTerminal = params.terminal.value
    const wasAtBottom = liveTerminal ? isScrolledToBottom(liveTerminal) : false
    params.fitAddon.fit()
    if (liveTerminal && wasAtBottom) {
      liveTerminal.scrollToBottom()
    }
  }

  /** Debounced fit — coalesces multiple resize events into a single rAF frame. */
  function fitDeferred() {
    if (params.state.fitRafId) return
    params.state.fitRafId = requestAnimationFrame(() => {
      params.state.fitRafId = 0
      fit()
    })
  }

  function cancelPendingFit() {
    if (params.state.fitRafId) cancelAnimationFrame(params.state.fitRafId)
  }

  return {
    ensureFitted,
    waitForReconnectRedrawSettle,
    waitForReconnectResizeDelay,
    resizeLiveSession,
    fit,
    fitDeferred,
    cancelPendingFit,
  }
}
