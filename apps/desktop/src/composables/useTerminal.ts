import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { openUrl } from "@tauri-apps/plugin-opener"
import { listen } from "../listen"
import { isTauri } from "../tauri-mock"
import {
  formatAttachFailureMessage,
  formatMissingInitialTaskSessionMessage,
  getRespawnToastKey,
  getReconnectRedrawPolicy,
  getReconnectResizeDelayMs,
  getReconnectKeyboardPush,
  getTerminalRecoveryMode,
  isExistingDaemonSessionFailure,
  isMissingDaemonSessionFailure,
  shouldRespawnAfterAttachFailure,
  shouldRunTerminalDispose,
  shouldSkipReconnect,
  shouldForceDoubleResizeOnReconnect,
  shouldReattachOnDaemonReady,
  shouldResetTerminalOnReconnect,
} from "./terminalSessionRecovery"
import { getAppErrorMessage } from "../appError"
import { markTaskSwitchFirstOutput } from "../perf/taskSwitchPerf"
import { markDaemonReadyObserved } from "./daemonReadyState"
import { useThemeRuntime } from "../theme/runtime"
import { getSharedStreamClient, onSharedStreamConnectionChange } from "./desktopStreamClient"
import type { StreamClient } from "@kanna/stream-client"
import { loadSessionRecoveryState } from "./sessionRecoveryState"
import { useToast } from "./useToast"
import i18n from "../i18n"
import { base64ToBytes, createTerminalInputQueue } from "./terminalInputQueue"
import { createTerminalClipboardBridge } from "./terminalClipboardBridge"
import { initializeTerminalView, type InitializedTerminalView } from "./terminalView"
import type { SpawnOptions, TerminalOptions } from "./terminalTypes"

export type { SpawnOptions, TerminalOptions } from "./terminalTypes"

export function resetTerminalOutputSubscriptionsForTests(): void {
  // Kept as a compatibility test hook; terminal output no longer uses Tauri
  // event subscriptions after the KSP migration.
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions, options?: TerminalOptions) {
  const { effectiveCodeTheme } = useThemeRuntime()
  const toast = useToast()
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  const instanceId = Math.random().toString(36).slice(2, 10)
  const outputDecoder = new TextDecoder()
  let unlistenExit: (() => void) | null = null
  let unlistenDaemonReady: (() => void) | null = null
  let unlistenStreamLost: (() => void) | null = null
  let unlistenSharedStreamConnection: (() => void) | null = null
  let container: HTMLElement | null = null
  let cleanupContainerEvents: (() => void) | null = null
  let cleanupNativeDropEvents: (() => void) | null = null
  let stopThemeWatch: (() => void) | null = null
  let terminalView: InitializedTerminalView | null = null
  let fitRafId = 0
  let attached = false
  let terminalStreamAttached = false
  let connecting = false
  let paused = false
  let connectionGeneration = 0
  let disposed = false
  let hasAttachedOnce = false
  let sessionExited = false
  let preserveRecoveredScrollbackForNextSnapshot = false
  let streamClient: StreamClient | null = null
  let respawningAfterAttachFailure = false

  function getLiveTerminal(): Terminal | null {
    return disposed ? null : terminal.value
  }

  function isCurrentListeningGeneration(generation: number): boolean {
    return !paused && !disposed && generation === connectionGeneration
  }

  function acceptRegisteredListener(
    generation: number,
    event: string,
    unlisten: () => void,
  ): boolean {
    if (isCurrentListeningGeneration(generation)) {
      console.warn("[terminal][instance] listener:add", {
        sessionId,
        instanceId,
        event,
      })
      return true
    }

    unlisten()
    console.warn("[terminal][instance] listener:remove", {
      sessionId,
      instanceId,
      event,
      reason: "late-registration",
    })
    return false
  }

  function isScrolledToBottom(term: Terminal) {
    const activeBuffer = term.buffer.active
    return activeBuffer.viewportY >= activeBuffer.baseY
  }

  function handleLinkActivate(_event: MouseEvent, uri: string) {
    if (isTauri) {
      openUrl(uri).catch((e) => console.error("[terminal] Failed to open URL:", e))
    } else {
      window.open(uri, "_blank")
    }
  }

  async function getTerminalStreamClient(): Promise<StreamClient> {
    streamClient ??= await getSharedStreamClient()
    return streamClient
  }

  const inputQueue = createTerminalInputQueue({
    sessionId,
    getTerminalStreamClient,
  })
  const clipboardBridge = createTerminalClipboardBridge({
    sessionId,
    instanceId,
    options,
    outputDecoder,
    sendInputBytes: inputQueue.sendInputBytes,
  })

  function init(el: HTMLElement) {
    container = el
    console.warn("[terminal][instance] init", {
      sessionId,
      instanceId,
      worktreePath: options?.worktreePath ?? null,
      agentProvider: options?.agentProvider ?? null,
    })
    stopThemeWatch?.()
    terminalView?.unregisterE2ETerminalBuffer()
    terminalView = initializeTerminalView({
      el,
      sessionId,
      instanceId,
      options,
      effectiveCodeTheme,
      fitAddon,
      getContainer: () => container,
      isDisposed: () => disposed,
      isAttached: () => attached,
      getStreamClient: () => streamClient,
      handleLinkActivate,
      sendInputBytes: inputQueue.sendInputBytes,
      maybeReadClipboardImage: clipboardBridge.maybeReadClipboardImage,
      sendDroppedPaths: clipboardBridge.sendDroppedPaths,
      onNativeDropCleanupReady: (cleanup) => {
        cleanupNativeDropEvents = cleanup
      },
      setTerminal: (term) => {
        terminal.value = term
      },
    })
    cleanupContainerEvents = terminalView.cleanupContainerEvents
    stopThemeWatch = terminalView.stopThemeWatch
  }

  /** Wait for the container to have non-zero dimensions, then fit the terminal. */
  async function ensureFitted() {
    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
      return
    }
    // Container not yet laid out — wait one animation frame for the browser to compute layout
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }
  }

  async function waitForReconnectRedrawSettle() {
    const policy = getReconnectRedrawPolicy(options)
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

      listen("status_changed", (event) => {
        const payload = event.payload || event
        if (payload?.session_id === sessionId && payload?.status === policy.waitForIdleStatus) {
          completeFromIdle()
        }
      }).then((unlisten) => {
        stopListening = unlisten
        if (settled) {
          stopListening()
        }
      }).catch(() => {
        clearTimeout(fallback)
        finish(0)
      })
    })
  }

  async function waitForReconnectResizeDelay() {
    const delayMs = getReconnectResizeDelayMs(options)
    if (delayMs <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  }

  async function resizeLiveSession(cols: number, rows: number, forceDouble: boolean) {
    const client = await getTerminalStreamClient()
    if (forceDouble) {
      const shrinkCols = Math.max(1, cols - 1)
      console.warn("[terminal][connect] resize:double", {
        sessionId,
        instanceId,
        cols,
        rows,
      })
      client.sendTermResize(sessionId, shrinkCols, rows)
      client.sendTermResize(sessionId, cols, rows)
      return
    }

    console.warn("[terminal][connect] resize:single", {
      sessionId,
      instanceId,
      cols,
      rows,
    })
    client.sendTermResize(sessionId, cols, rows)
  }

  async function connectSession() {
    if (paused) return
    if (sessionExited) return
    if (shouldSkipReconnect(connecting, attached)) return
    const generation = connectionGeneration
    connecting = true
    const shouldApplyReconnectEffects = hasAttachedOnce
    console.warn("[terminal][connect] start", {
      sessionId,
      recoveryMode: getTerminalRecoveryMode(spawnOptions, options),
      attached,
      connecting,
      hasAttachedOnce,
      instanceId,
      skipInitialReconnectEffects: options?.skipInitialReconnectEffects ?? false,
      shouldApplyReconnectEffects,
      agentProvider: options?.agentProvider ?? null,
    })

    try {
      const client = await getTerminalStreamClient()
      if (paused || generation !== connectionGeneration) return

      if (!hasAttachedOnce && getTerminalRecoveryMode(spawnOptions, options) === "spawn-on-missing" && spawnOptions) {
        const liveTerminal = getLiveTerminal()
        if (liveTerminal) {
          await ensureFitted()
          const fittedTerminal = getLiveTerminal()
          if (!fittedTerminal) return
          const { cols, rows } = fittedTerminal
          try {
            await spawnOptions.spawnFn(sessionId, spawnOptions.cwd, spawnOptions.prompt, cols, rows)
          } catch (error) {
            if (!isExistingDaemonSessionFailure(error)) {
              throw error
            }
          }
        }
      }

      if (!terminalStreamAttached) {
        client.attachTerminal(sessionId, {
          onSnapshot: (_cols, _rows, dataB64) => {
            const liveTerminal = getLiveTerminal()
            if (!liveTerminal) return
            const vt = new TextDecoder().decode(base64ToBytes(dataB64))
            if (!preserveRecoveredScrollbackForNextSnapshot && shouldResetTerminalOnReconnect(options)) {
              liveTerminal.reset()
            }
            preserveRecoveredScrollbackForNextSnapshot = false
            clipboardBridge.restoreTerminalModesFromSnapshot(vt)
            liveTerminal.write(vt)
          },
          onOutput: (dataB64) => {
            const liveTerminal = getLiveTerminal()
            if (!liveTerminal) return
            markTaskSwitchFirstOutput(sessionId)
            const bytes = base64ToBytes(dataB64)
            clipboardBridge.handleTerminalOutputControlSequences(bytes)
            liveTerminal.write(bytes)
          },
          onSessionExit: (code) => {
            attached = false
            sessionExited = true
            terminal.value?.write(`\r\n[Process exited with code ${code}]\r\n`)
          },
          onError: (code, message) => {
            void handleAttachError({ code, message })
          },
        })
        terminalStreamAttached = true
      }

      console.warn("[terminal][connect] attach:ok", {
        sessionId,
        instanceId,
        shouldApplyReconnectEffects,
      })

      const liveTerminal = getLiveTerminal()
      if (liveTerminal) {
        const reconnectKeyboardPush = getReconnectKeyboardPush({
          ...options,
          kittyKeyboard: options?.kittyKeyboard,
        })
        if (reconnectKeyboardPush) {
          liveTerminal.write(reconnectKeyboardPush)
        }
        await ensureFitted()
        const resizedTerminal = getLiveTerminal()
        if (!resizedTerminal) return
        const { cols, rows } = resizedTerminal
        if (shouldApplyReconnectEffects) {
          await waitForReconnectRedrawSettle()
          if (!getLiveTerminal()) return
          await waitForReconnectResizeDelay()
          await resizeLiveSession(cols, rows, shouldForceDoubleResizeOnReconnect(options))
        } else {
          await resizeLiveSession(cols, rows, shouldForceDoubleResizeOnReconnect(options))
        }
      }

      attached = true
      hasAttachedOnce = true
      sessionExited = false
    } catch (e) {
      const msg = getAppErrorMessage(e)
      console.warn("[terminal][connect] attach:error", {
        sessionId,
        instanceId,
        error: msg,
      })
      if (isMissingDaemonSessionFailure(e) && getTerminalRecoveryMode(spawnOptions, options) === "spawn-on-missing") {
        terminalStreamAttached = false
      }
      terminal.value?.write(formatAttachFailureMessage(msg))
    } finally {
      connecting = false
      console.warn("[terminal][connect] end", {
        sessionId,
        attached,
        connecting,
        hasAttachedOnce,
        instanceId,
      })
    }
  }

  async function handleAttachError(error: { code?: string; message: string }) {
    if (respawningAfterAttachFailure) return
    const normalizedError = {
      ...error,
      code: error.code === "no_session" ? "session_not_found" : error.code,
    }
    attached = false
    terminalStreamAttached = false

    const recoveryState = await loadSessionRecoveryState(sessionId).catch(() => null)
    const hasRecoveryState = Boolean(recoveryState?.serialized)
    if (!shouldRespawnAfterAttachFailure(normalizedError, hasAttachedOnce, hasRecoveryState, spawnOptions, options)) {
      terminal.value?.write(
        isMissingDaemonSessionFailure(normalizedError) && getTerminalRecoveryMode(spawnOptions, options) === "attach-only"
          ? formatMissingInitialTaskSessionMessage()
          : formatAttachFailureMessage(normalizedError.message)
      )
      return
    }

    const liveTerminal = getLiveTerminal()
    if (!spawnOptions || !liveTerminal) return

    respawningAfterAttachFailure = true
    try {
      if (recoveryState?.serialized) {
        liveTerminal.reset()
        clipboardBridge.restoreTerminalModesFromSnapshot(recoveryState.serialized)
        liveTerminal.write(recoveryState.serialized)
        preserveRecoveredScrollbackForNextSnapshot = true
      }
      toast.warning(i18n.global.t(getRespawnToastKey(normalizedError, hasRecoveryState)))
      await ensureFitted()
      const fittedTerminal = getLiveTerminal()
      if (!fittedTerminal) return
      if (options?.recoverSession) {
        await options.recoverSession(sessionId, {
          cols: fittedTerminal.cols,
          rows: fittedTerminal.rows,
        })
      } else {
        await spawnOptions.spawnFn(
          sessionId,
          spawnOptions.cwd,
          spawnOptions.prompt,
          fittedTerminal.cols,
          fittedTerminal.rows,
        )
      }
      attached = false
      terminalStreamAttached = false
      connecting = false
      sessionExited = false
      await connectSession()
    } finally {
      respawningAfterAttachFailure = false
    }
  }

  async function startListening() {
    paused = false
    connectionGeneration += 1
    const listeningGeneration = connectionGeneration
    const teardownId = `td-${sessionId}`
    console.warn("[terminal][instance] startListening", {
      sessionId,
      teardownId,
      instanceId,
      hasExitListener: unlistenExit != null,
      hasDaemonReadyListener: unlistenDaemonReady != null,
      hasStreamLostListener: unlistenStreamLost != null,
      attached,
      connecting,
      hasAttachedOnce,
    })

    if (!unlistenExit) {
      const exitUnlisten = await listen(
        "session_exit",
        (event) => {
          const sid = event.payload.session_id
          if (sid === sessionId || sid === teardownId) {
            if (sid === sessionId) {
              attached = false
              sessionExited = true
            }
            if (terminal.value) {
              terminal.value.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
            }
          }
        }
      )
      if (!acceptRegisteredListener(listeningGeneration, "session_exit", exitUnlisten)) return
      unlistenExit = exitUnlisten
    }

    if (!unlistenDaemonReady && shouldReattachOnDaemonReady(spawnOptions, options)) {
      const daemonReadyUnlisten = await listen("daemon_ready", () => {
        markDaemonReadyObserved()
        console.warn("[terminal][event] daemon_ready", {
          sessionId,
          instanceId,
          attached,
          connecting,
          hasAttachedOnce,
        })
        if (attached || connecting) return
        connectSession().catch((e) =>
          console.error("[terminal] daemon_ready re-attach failed:", e)
        )
      })
      if (!acceptRegisteredListener(listeningGeneration, "daemon_ready", daemonReadyUnlisten)) return
      unlistenDaemonReady = daemonReadyUnlisten
    }

    if (!unlistenStreamLost) {
      const streamLostUnlisten = await listen("session_stream_lost", (event) => {
        const sid = event.payload?.session_id
        if (sid === sessionId) {
          attached = false
          terminalStreamAttached = false
          console.warn("[terminal][event] session_stream_lost", {
            sessionId,
            instanceId,
            attached,
            connecting,
            hasAttachedOnce,
          })
          if (shouldReattachOnDaemonReady(spawnOptions, options) && !connecting) {
            connectSession().catch((e) =>
              console.error("[terminal] session_stream_lost re-attach failed:", e)
            )
          }
        }
      })
      if (!acceptRegisteredListener(listeningGeneration, "session_stream_lost", streamLostUnlisten)) return
      unlistenStreamLost = streamLostUnlisten
    }

    if (!unlistenSharedStreamConnection) {
      unlistenSharedStreamConnection = onSharedStreamConnectionChange((connected) => {
        if (!connected || paused || disposed || !hasAttachedOnce) return
        attached = true
        const liveTerminal = getLiveTerminal()
        if (!liveTerminal || connecting) return
        fit()
        void resizeLiveSession(liveTerminal.cols, liveTerminal.rows, shouldForceDoubleResizeOnReconnect(options))
      })
    }

    if (!isCurrentListeningGeneration(listeningGeneration)) return
    await connectSession()
  }

  function pause() {
    paused = true
    connectionGeneration += 1
    void inputQueue.flushQueuedInput()
    const shouldDetach = attached || connecting || hasAttachedOnce
    attached = false
    terminalStreamAttached = false
    connecting = false
    if (shouldDetach) {
      streamClient?.detach(sessionId, "terminal")
    }
    if (unlistenExit) {
      unlistenExit()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "session_exit",
      })
      unlistenExit = null
    }
    if (unlistenDaemonReady) {
      unlistenDaemonReady()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "daemon_ready",
      })
      unlistenDaemonReady = null
    }
    if (unlistenStreamLost) {
      unlistenStreamLost()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "session_stream_lost",
      })
      unlistenStreamLost = null
    }
    if (unlistenSharedStreamConnection) {
      unlistenSharedStreamConnection()
      unlistenSharedStreamConnection = null
    }
  }

  function fit() {
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return
    const liveTerminal = terminal.value
    const wasAtBottom = liveTerminal ? isScrolledToBottom(liveTerminal) : false
    fitAddon.fit()
    if (liveTerminal && wasAtBottom) {
      liveTerminal.scrollToBottom()
    }
  }

  /** Debounced fit — coalesces multiple resize events into a single rAF frame. */
  function fitDeferred() {
    if (fitRafId) return
    fitRafId = requestAnimationFrame(() => {
      fitRafId = 0
      fit()
    })
  }

  function dispose() {
    if (!shouldRunTerminalDispose(disposed)) return
    console.warn("[terminal][instance] dispose:start", {
      sessionId,
      instanceId,
      attached,
      connecting,
      hasAttachedOnce,
      hasExitListener: unlistenExit != null,
      hasDaemonReadyListener: unlistenDaemonReady != null,
      hasStreamLostListener: unlistenStreamLost != null,
    })
    void inputQueue.flushQueuedInput()
    if (attached || connecting || hasAttachedOnce) {
      streamClient?.detach(sessionId, "terminal")
    }
    disposed = true
    attached = false
    terminalStreamAttached = false
    terminalView?.fileLinkProvider.clearFileExistsCache()
    if (fitRafId) cancelAnimationFrame(fitRafId)
    inputQueue.clearPendingInputFlushTimer()
    cleanupContainerEvents?.()
    cleanupContainerEvents = null
    cleanupNativeDropEvents?.()
    cleanupNativeDropEvents = null
    stopThemeWatch?.()
    stopThemeWatch = null
    terminalView?.unregisterE2ETerminalBuffer()
    terminalView?.dropBridge.resetNativeDropDedupe()
    terminalView = null
    clipboardBridge.reset()
    if (unlistenExit) {
      unlistenExit()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "session_exit",
      })
    }
    if (unlistenDaemonReady) {
      unlistenDaemonReady()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "daemon_ready",
      })
    }
    if (unlistenStreamLost) {
      unlistenStreamLost()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "session_stream_lost",
      })
    }
    if (unlistenSharedStreamConnection) {
      unlistenSharedStreamConnection()
    }
    terminal.value?.dispose()
    terminal.value = null
    unlistenExit = null
    unlistenDaemonReady = null
    unlistenStreamLost = null
    unlistenSharedStreamConnection = null
    container = null
    console.warn("[terminal][instance] dispose:end", {
      sessionId,
      instanceId,
    })
  }

  onUnmounted(() => {
    dispose()
  })

  /** Re-fit the terminal and send SIGWINCH to force TUI apps to redraw.
   *  If the session is dead, re-attach or re-spawn. */
  async function redraw() {
    if (!terminal.value) return
    fit()
    // Try resize; if it fails, the session is dead, so re-run startListening.
    try {
      const { cols, rows } = terminal.value
      await resizeLiveSession(cols, rows, false)
    } catch {
      await startListening()
      return
    }
    const { cols, rows } = terminal.value
    await resizeLiveSession(cols, rows, true).catch(() => {})
  }

  /** When a hidden terminal becomes visible again, verify the session is still
   *  attached. If the daemon restarted while it was hidden, reconnect on demand. */
  async function ensureConnected() {
    if (!terminal.value) return
    if (getTerminalRecoveryMode(spawnOptions, options) === "attach-only") {
      await connectSession()
      return
    }

    fit()
    try {
      const { cols, rows } = terminal.value
      await resizeLiveSession(cols, rows, false)
    } catch {
      attached = false
      await startListening()
    }
  }

  return { terminal, init, startListening, fit, fitDeferred, redraw, ensureConnected, pause, dispose }
}
