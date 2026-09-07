import type { Ref } from "vue"
import type { Terminal } from "@xterm/xterm"
import type { StreamClient } from "@kanna/stream-client"
import { invoke } from "../invoke"
import { listen } from "../listen"
import { getAppErrorMessage } from "../appError"
import { markTaskSwitchFirstOutput } from "../perf/taskSwitchPerf"
import { forwardTerminalRuntimeStatus } from "./terminalRuntimeStatusSink"
import {
  attachTerminalOutputPerf,
  type TerminalOutputPerfHandle,
} from "../perf/terminalOutputPerf"
import { markDaemonReadyObserved } from "./daemonReadyState"
import { onSharedStreamConnectionChange } from "./desktopStreamClient"
import { loadSessionRecoveryState } from "./sessionRecoveryState"
import i18n from "../i18n"
import { createTerminalDisposalController } from "./terminalDisposal"
import {
  formatAttachFailureMessage,
  formatMissingInitialTaskSessionMessage,
  getRespawnToastKey,
  getReconnectKeyboardPush,
  getTerminalRecoveryMode,
  isExistingDaemonSessionFailure,
  isMissingDaemonSessionFailure,
  shouldForceDoubleResizeOnReconnect,
  shouldReattachOnDaemonReady,
  shouldResetTerminalForSnapshot,
  shouldRespawnAfterAttachFailure,
  shouldSkipReconnect,
} from "./terminalSessionRecovery"
import { base64ToBytes, type TerminalInputQueue } from "./terminalInputQueue"
import type { TerminalClipboardBridge } from "./terminalClipboardBridge"
import type { TerminalLayoutController } from "./terminalLayout"
import {
  acceptRegisteredListener,
  getLiveTerminal as getLiveTerminalFromState,
  isCurrentListeningGeneration,
  type TerminalRuntimeState,
} from "./terminalRuntimeState"
import type { SpawnOptions, TerminalOptions } from "./terminalTypes"

interface ToastLike {
  warning(message: string): void
}

export interface TerminalSessionLifecycleController {
  startListening(): Promise<void>
  pause(): void
  dispose(): void
  redraw(): Promise<void>
  ensureConnected(): Promise<void>
}

export function createTerminalSessionLifecycle(params: {
  sessionId: string
  instanceId: string
  state: TerminalRuntimeState
  terminal: Ref<Terminal | null>
  spawnOptions?: SpawnOptions
  options?: TerminalOptions
  inputQueue: TerminalInputQueue
  clipboardBridge: TerminalClipboardBridge
  layout: TerminalLayoutController
  toast: ToastLike
  getTerminalStreamClient: () => Promise<StreamClient>
}): TerminalSessionLifecycleController {
  function getLiveTerminal(): Terminal | null {
    return getLiveTerminalFromState(params.state, params.terminal)
  }
  const disposal = createTerminalDisposalController({
    sessionId: params.sessionId,
    instanceId: params.instanceId,
    state: params.state,
    terminal: params.terminal,
    inputQueue: params.inputQueue,
    clipboardBridge: params.clipboardBridge,
    layout: params.layout,
  })
  let outputPerf: TerminalOutputPerfHandle | null = null
  let attachFailureSignal = 0

  function clearAttachRetry(resetFailure: boolean): void {
    if (params.state.attachRetryTimer) clearTimeout(params.state.attachRetryTimer)
    params.state.attachRetryTimer = null
    if (resetFailure) {
      params.state.attachRetryAttempt = 0
      params.state.attachFailureMessage = null
    }
  }

  function reportAttachFailure(message: string): void {
    // Several recovery signals can report the same refusal before the pending
    // retry fires. They all belong to that one attempt and must not advance
    // the exponential backoff independently.
    if (params.state.attachRetryTimer || params.state.paused || params.state.disposed) return
    const delayMs = Math.min(1_000 * 2 ** params.state.attachRetryAttempt, 30_000)
    params.state.attachRetryAttempt += 1
    if (params.state.attachFailureMessage !== message) {
      params.terminal.value?.write(formatAttachFailureMessage(message, delayMs / 1_000))
      params.state.attachFailureMessage = message
    }
    params.state.attachRetryTimer = setTimeout(() => {
      params.state.attachRetryTimer = null
      if (params.state.paused || params.state.disposed) return
      void connectSession().catch((error) =>
        console.error("[terminal] backed-off re-attach failed:", error)
      )
    }, delayMs)
  }

  async function connectSession() {
    if (params.state.paused) return
    // Every recovery signal funnels through the same timer once an attach has
    // been refused. This prevents daemon-ready, stream-lost, and shared-stream
    // events from bypassing the backoff and repeating the same doomed resize.
    if (params.state.attachRetryTimer) return
    if (params.state.sessionExited) {
      console.warn("[terminal][connect] skip: session exited", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
      })
      return
    }
    if (shouldSkipReconnect(params.state.connecting, params.state.attached)) return
    const generation = params.state.connectionGeneration
    const failureSignalAtStart = attachFailureSignal
    params.state.connecting = true
    params.state.connectSpawnedSession = false
    const shouldApplyReconnectEffects = params.state.hasAttachedOnce
    console.warn("[terminal][connect] start", {
      sessionId: params.sessionId,
      recoveryMode: getTerminalRecoveryMode(params.spawnOptions, params.options),
      attached: params.state.attached,
      connecting: params.state.connecting,
      hasAttachedOnce: params.state.hasAttachedOnce,
      instanceId: params.instanceId,
      skipInitialReconnectEffects: params.options?.skipInitialReconnectEffects ?? false,
      shouldApplyReconnectEffects,
      agentProvider: params.options?.agentProvider ?? null,
    })

    try {
      const client = await params.getTerminalStreamClient()
      if (params.state.paused || generation !== params.state.connectionGeneration) return

      if (!params.state.hasAttachedOnce && getTerminalRecoveryMode(params.spawnOptions, params.options) === "spawn-on-missing" && params.spawnOptions) {
        const liveTerminal = getLiveTerminal()
        if (liveTerminal) {
          await params.layout.ensureFitted()
          const fittedTerminal = getLiveTerminal()
          if (!fittedTerminal) return
          const { cols, rows } = fittedTerminal
          try {
            params.state.connectSpawnedSession = true
            await params.spawnOptions.spawnFn(params.sessionId, params.spawnOptions.cwd, params.spawnOptions.prompt, cols, rows)
          } catch (error) {
            if (!isExistingDaemonSessionFailure(error)) {
              throw error
            }
          }
        }
      }

      if (!params.state.terminalStreamAttached) {
        client.attachTerminal(params.sessionId, {
          onSnapshot: (_cols, _rows, dataB64, agentProvider) => {
            const liveTerminal = getLiveTerminal()
            if (!liveTerminal) return
            const vt = new TextDecoder().decode(base64ToBytes(dataB64))
            if (
              shouldResetTerminalForSnapshot({
                preserveRecoveredScrollback:
                  params.state.preserveRecoveredScrollbackForNextSnapshot,
                sessionRespawned: params.state.resetTerminalOnNextSnapshot,
                agentProvider: agentProvider ?? params.options?.agentProvider,
              })
            ) {
              liveTerminal.reset()
            }
            params.state.preserveRecoveredScrollbackForNextSnapshot = false
            params.state.resetTerminalOnNextSnapshot = false
            params.clipboardBridge.restoreTerminalModesFromSnapshot(vt)
            liveTerminal.write(vt)
          },
          onOutput: (dataB64, metadata) => {
            const perf = outputPerf
            perf?.frameReceived(metadata?.receivedAtMs ?? performance.now(), dataB64.length)
            const liveTerminal = getLiveTerminal()
            if (!liveTerminal) return
            markTaskSwitchFirstOutput(params.sessionId)
            const decodeStartedAt = performance.now()
            const bytes = base64ToBytes(dataB64)
            perf?.recordDecode(performance.now() - decodeStartedAt, bytes.length)
            params.clipboardBridge.handleTerminalOutputControlSequences(bytes)
            const completeWrite = perf?.beginXtermWrite(bytes.length)
            if (completeWrite) {
              liveTerminal.write(bytes, completeWrite)
            } else {
              liveTerminal.write(bytes)
            }
          },
          onStatus: (status) => {
            void forwardTerminalRuntimeStatus(params.sessionId, status).catch((error) => {
              console.error("[terminal] failed to apply runtime status:", error)
            })
          },
          onSessionExit: (code) => {
            params.state.attached = false
            params.state.terminalStreamAttached = false
            params.state.sessionExited = true
            params.terminal.value?.write(`\r\n[Process exited with code ${code}]\r\n`)
          },
          onError: (code, message) => {
            void handleAttachError({ code, message })
          },
        })
        params.state.terminalStreamAttached = true
      }

      // A structured refusal can arrive while attachTerminal registers the
      // stream. Leave its failure handler and timer in charge; applying the
      // reconnect redraw/resize here would be both doomed and capable of
      // outliving the pending backoff interval.
      if (attachFailureSignal !== failureSignalAtStart) return

      console.warn("[terminal][connect] attach:ok", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        shouldApplyReconnectEffects,
      })

      const liveTerminal = getLiveTerminal()
      if (liveTerminal) {
        const reconnectKeyboardPush = getReconnectKeyboardPush({
          ...params.options,
          kittyKeyboard: params.options?.kittyKeyboard,
        })
        if (reconnectKeyboardPush) {
          liveTerminal.write(reconnectKeyboardPush)
        }
        await params.layout.ensureFitted()
        const resizedTerminal = getLiveTerminal()
        if (!resizedTerminal) return
        const { cols, rows } = resizedTerminal
        if (shouldApplyReconnectEffects) {
          await params.layout.waitForReconnectRedrawSettle()
          if (!getLiveTerminal()) return
          await params.layout.waitForReconnectResizeDelay()
          await params.layout.resizeLiveSession(cols, rows, shouldForceDoubleResizeOnReconnect(params.options))
        } else {
          await params.layout.resizeLiveSession(cols, rows, shouldForceDoubleResizeOnReconnect(params.options))
        }
      }

      params.state.attached = true
      params.state.hasAttachedOnce = true
      params.state.sessionExited = false
      if (attachFailureSignal === failureSignalAtStart) {
        clearAttachRetry(true)
      }
    } catch (e) {
      const msg = getAppErrorMessage(e)
      console.warn("[terminal][connect] attach:error", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        error: msg,
      })
      if (isMissingDaemonSessionFailure(e) && getTerminalRecoveryMode(params.spawnOptions, params.options) === "spawn-on-missing") {
        params.state.terminalStreamAttached = false
      }
      reportAttachFailure(msg)
    } finally {
      params.state.connecting = false
      console.warn("[terminal][connect] end", {
        sessionId: params.sessionId,
        attached: params.state.attached,
        connecting: params.state.connecting,
        hasAttachedOnce: params.state.hasAttachedOnce,
        instanceId: params.instanceId,
      })
      if (params.state.pendingSessionCreatedRebind) {
        params.state.pendingSessionCreatedRebind = false
        if (!params.state.paused && !params.state.disposed) {
          console.warn("[terminal][event] applying deferred session_created rebind", {
            sessionId: params.sessionId,
            instanceId: params.instanceId,
          })
          params.state.sessionExited = false
          params.state.attached = false
          params.state.terminalStreamAttached = false
          params.state.resetTerminalOnNextSnapshot = true
          clearAttachRetry(true)
          void connectSession().catch((e) =>
            console.error("[terminal] deferred session_created re-attach failed:", e)
          )
        }
      }
    }
  }

  /** A stage swap kills and respawns this session id in place. When that
   *  happens while this view is paused, the exit can already be latched
   *  (sessionExited) while the session_created rebind that would clear it is
   *  never delivered to the paused view — the latch then vetoes every
   *  reconnect and the view stays frozen on a stale frame. Before honoring
   *  the latch on an explicit resume, ask the daemon whether the session id
   *  is live again; if it is, the recorded exit belongs to a previous PTY and
   *  must not block the attach. */
  async function reconcileStaleExitLatch() {
    if (!params.state.sessionExited) return
    let alive = false
    try {
      const sessions = await invoke<{ session_id?: string }[] | null>("list_sessions")
      alive = Array.isArray(sessions) &&
        sessions.some((session) => session?.session_id === params.sessionId)
    } catch (e) {
      console.warn("[terminal][connect] stale exit-latch probe failed", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        error: getAppErrorMessage(e),
      })
      return
    }
    if (!alive) return
    console.warn("[terminal][connect] clearing stale exit latch for respawned session", {
      sessionId: params.sessionId,
      instanceId: params.instanceId,
    })
    params.state.sessionExited = false
    params.state.attached = false
    params.state.terminalStreamAttached = false
    // Same reasoning as the session_created rebind: a respawned id means the
    // shown content belongs to a dead PTY, so the next snapshot replaces it.
    params.state.resetTerminalOnNextSnapshot = true
  }

  async function handleAttachError(error: { code?: string; message: string }) {
    attachFailureSignal += 1
    if (params.state.respawningAfterAttachFailure) return
    const normalizedError = {
      ...error,
      code: error.code === "no_session" ? "session_not_found" : error.code,
    }
    params.state.attached = false
    params.state.terminalStreamAttached = false

    const recoveryState = await loadSessionRecoveryState(params.sessionId).catch(() => null)
    const hasRecoveryState = Boolean(recoveryState?.serialized)
    if (!shouldRespawnAfterAttachFailure(normalizedError, params.state.hasAttachedOnce, hasRecoveryState, params.spawnOptions, params.options)) {
      if (isMissingDaemonSessionFailure(normalizedError) && getTerminalRecoveryMode(params.spawnOptions, params.options) === "attach-only") {
        params.terminal.value?.write(formatMissingInitialTaskSessionMessage())
      } else {
        reportAttachFailure(normalizedError.message)
      }
      return
    }

    const liveTerminal = getLiveTerminal()
    if (!params.spawnOptions || !liveTerminal) return

    params.state.respawningAfterAttachFailure = true
    try {
      if (recoveryState?.serialized) {
        liveTerminal.reset()
        params.clipboardBridge.restoreTerminalModesFromSnapshot(recoveryState.serialized)
        liveTerminal.write(recoveryState.serialized)
        params.state.preserveRecoveredScrollbackForNextSnapshot = true
      }
      params.toast.warning(i18n.global.t(getRespawnToastKey(normalizedError, hasRecoveryState)))
      await params.layout.ensureFitted()
      const fittedTerminal = getLiveTerminal()
      if (!fittedTerminal) return
      if (params.options?.recoverSession) {
        await params.options.recoverSession(params.sessionId, {
          cols: fittedTerminal.cols,
          rows: fittedTerminal.rows,
        })
      } else {
        await params.spawnOptions.spawnFn(
          params.sessionId,
          params.spawnOptions.cwd,
          params.spawnOptions.prompt,
          fittedTerminal.cols,
          fittedTerminal.rows,
        )
      }
      params.state.attached = false
      params.state.terminalStreamAttached = false
      params.state.connecting = false
      params.state.sessionExited = false
      await connectSession()
    } finally {
      params.state.respawningAfterAttachFailure = false
    }
  }

  async function startListening() {
    params.state.paused = false
    outputPerf ??= attachTerminalOutputPerf(params.sessionId)
    params.state.connectionGeneration += 1
    const listeningGeneration = params.state.connectionGeneration
    const teardownId = `td-${params.sessionId}`
    console.warn("[terminal][instance] startListening", {
      sessionId: params.sessionId,
      teardownId,
      instanceId: params.instanceId,
      hasExitListener: params.state.unlistenExit != null,
      hasDaemonReadyListener: params.state.unlistenDaemonReady != null,
      hasStreamLostListener: params.state.unlistenStreamLost != null,
      attached: params.state.attached,
      connecting: params.state.connecting,
      hasAttachedOnce: params.state.hasAttachedOnce,
    })

    if (!params.state.unlistenExit) {
      const exitUnlisten = await listen(
        "session_exit",
        (event) => {
          const sid = event.payload.session_id
          if (sid === params.sessionId || sid === teardownId) {
            if (sid === params.sessionId) {
              params.state.attached = false
              params.state.terminalStreamAttached = false
              params.state.sessionExited = true
            }
            if (params.terminal.value) {
              params.terminal.value.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
            }
          }
        }
      )
      if (!acceptRegisteredListener({
        state: params.state,
        generation: listeningGeneration,
        event: "session_exit",
        unlisten: exitUnlisten,
        sessionId: params.sessionId,
        instanceId: params.instanceId,
      })) return
      params.state.unlistenExit = exitUnlisten
    }

    if (!params.state.unlistenSessionCreated) {
      // Stage transitions replace the task's agent session in place: the
      // engine kills this session id and respawns it with the next stage's
      // agent. A SessionCreated for this id therefore means a new PTY now
      // backs it and any prior attachment is stale; rebind regardless of
      // what our attach state claims. Only an in-flight connect is exempt:
      // it spawned this very session and is already attaching to it.
      const sessionCreatedUnlisten = await listen(
        "session_created",
        (event) => {
          const sid = (event.payload as { session_id?: string } | undefined)?.session_id
          if (sid !== params.sessionId) return
          if (params.state.connecting) {
            // The in-flight connect spawned this very session and is already
            // attaching to it; any other in-flight connect may be racing a
            // stage-swap respawn and must rebind once it settles instead of
            // dropping the signal.
            if (params.state.connectSpawnedSession) return
            params.state.pendingSessionCreatedRebind = true
            console.warn("[terminal][event] session_created during connect; rebind deferred", {
              sessionId: params.sessionId,
              instanceId: params.instanceId,
            })
            return
          }
          console.warn("[terminal][event] session_created rebind", {
            sessionId: params.sessionId,
            instanceId: params.instanceId,
            sessionExited: params.state.sessionExited,
            attached: params.state.attached,
          })
          params.state.sessionExited = false
          params.state.attached = false
          params.state.terminalStreamAttached = false
          // A new PTY backs this id now; the next snapshot must replace the
          // dead incarnation's content, whatever the provider's ordinary
          // reconnect behavior is (see TerminalRuntimeState).
          params.state.resetTerminalOnNextSnapshot = true
          clearAttachRetry(true)
          connectSession().catch((e) =>
            console.error("[terminal] session_created re-attach failed:", e)
          )
        }
      )
      if (!acceptRegisteredListener({
        state: params.state,
        generation: listeningGeneration,
        event: "session_created",
        unlisten: sessionCreatedUnlisten,
        sessionId: params.sessionId,
        instanceId: params.instanceId,
      })) return
      params.state.unlistenSessionCreated = sessionCreatedUnlisten
    }

    if (!params.state.unlistenDaemonReady && shouldReattachOnDaemonReady(params.spawnOptions, params.options)) {
      const daemonReadyUnlisten = await listen("daemon_ready", () => {
        markDaemonReadyObserved()
        console.warn("[terminal][event] daemon_ready", {
          sessionId: params.sessionId,
          instanceId: params.instanceId,
          attached: params.state.attached,
          connecting: params.state.connecting,
          hasAttachedOnce: params.state.hasAttachedOnce,
        })
        if (params.state.attached || params.state.connecting) return
        connectSession().catch((e) =>
          console.error("[terminal] daemon_ready re-attach failed:", e)
        )
      })
      if (!acceptRegisteredListener({
        state: params.state,
        generation: listeningGeneration,
        event: "daemon_ready",
        unlisten: daemonReadyUnlisten,
        sessionId: params.sessionId,
        instanceId: params.instanceId,
      })) return
      params.state.unlistenDaemonReady = daemonReadyUnlisten
    }

    if (!params.state.unlistenStreamLost) {
      const streamLostUnlisten = await listen("session_stream_lost", (event) => {
        const sid = event.payload?.session_id
        if (sid === params.sessionId) {
          params.state.attached = false
          params.state.terminalStreamAttached = false
          console.warn("[terminal][event] session_stream_lost", {
            sessionId: params.sessionId,
            instanceId: params.instanceId,
            attached: params.state.attached,
            connecting: params.state.connecting,
            hasAttachedOnce: params.state.hasAttachedOnce,
          })
          if (shouldReattachOnDaemonReady(params.spawnOptions, params.options) && !params.state.connecting) {
            connectSession().catch((e) =>
              console.error("[terminal] session_stream_lost re-attach failed:", e)
            )
          }
        }
      })
      if (!acceptRegisteredListener({
        state: params.state,
        generation: listeningGeneration,
        event: "session_stream_lost",
        unlisten: streamLostUnlisten,
        sessionId: params.sessionId,
        instanceId: params.instanceId,
      })) return
      params.state.unlistenStreamLost = streamLostUnlisten
    }

    if (!params.state.unlistenSharedStreamConnection) {
      params.state.unlistenSharedStreamConnection = onSharedStreamConnectionChange((connected) => {
        if (!connected || params.state.paused || params.state.disposed || !params.state.hasAttachedOnce) return
        if (!params.state.terminalStreamAttached) {
          // The stream connection came back but this session has no live
          // attachment for the client to resync — reconnect explicitly
          // rather than claiming an attachment that does not exist.
          // connectSession itself vetoes exited/connecting states.
          void connectSession().catch((e) =>
            console.error("[terminal] stream reconnect re-attach failed:", e)
          )
          return
        }
        params.state.attached = true
        const liveTerminal = getLiveTerminal()
        if (!liveTerminal || params.state.connecting || params.state.attachFailureMessage) return
        params.layout.fit()
        void params.layout.resizeLiveSession(liveTerminal.cols, liveTerminal.rows, shouldForceDoubleResizeOnReconnect(params.options))
      })
    }

    if (!isCurrentListeningGeneration(params.state, listeningGeneration)) return
    await reconcileStaleExitLatch()
    if (!isCurrentListeningGeneration(params.state, listeningGeneration)) return
    await connectSession()
  }

  function pause() {
    params.state.paused = true
    outputPerf?.dispose()
    outputPerf = null
    params.state.connectionGeneration += 1
    void params.inputQueue.flushQueuedInput()
    const shouldDetach = params.state.attached || params.state.connecting || params.state.hasAttachedOnce
    params.state.attached = false
    params.state.terminalStreamAttached = false
    params.state.connecting = false
    clearAttachRetry(true)
    if (shouldDetach) {
      params.state.streamClient?.detach(params.sessionId, "terminal")
    }
    if (params.state.unlistenExit) {
      params.state.unlistenExit()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "session_exit",
      })
      params.state.unlistenExit = null
    }
    if (params.state.unlistenSessionCreated) {
      params.state.unlistenSessionCreated()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "session_created",
      })
      params.state.unlistenSessionCreated = null
    }
    if (params.state.unlistenDaemonReady) {
      params.state.unlistenDaemonReady()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "daemon_ready",
      })
      params.state.unlistenDaemonReady = null
    }
    if (params.state.unlistenStreamLost) {
      params.state.unlistenStreamLost()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "session_stream_lost",
      })
      params.state.unlistenStreamLost = null
    }
    if (params.state.unlistenSharedStreamConnection) {
      params.state.unlistenSharedStreamConnection()
      params.state.unlistenSharedStreamConnection = null
    }
  }

  /** Re-fit the terminal and send SIGWINCH to force TUI apps to redraw.
   *  If the session is dead, re-attach or re-spawn. */
  async function redraw() {
    if (!params.terminal.value) return
    if (params.state.attachFailureMessage) {
      await connectSession()
      return
    }
    params.layout.fit()
    // Try resize; if it fails, the session is dead, so re-run startListening.
    try {
      const { cols, rows } = params.terminal.value
      await params.layout.resizeLiveSession(cols, rows, false)
    } catch {
      await startListening()
      return
    }
    const { cols, rows } = params.terminal.value
    await params.layout.resizeLiveSession(cols, rows, true).catch(() => {})
  }

  /** When a hidden terminal becomes visible again, verify the session is still
   *  attached. If the daemon restarted while it was hidden, reconnect on demand. */
  async function ensureConnected() {
    if (!params.terminal.value) return
    if (params.state.attachFailureMessage) {
      await connectSession()
      return
    }
    if (getTerminalRecoveryMode(params.spawnOptions, params.options) === "attach-only") {
      await reconcileStaleExitLatch()
      await connectSession()
      return
    }

    params.layout.fit()
    try {
      const { cols, rows } = params.terminal.value
      await params.layout.resizeLiveSession(cols, rows, false)
    } catch {
      params.state.attached = false
      await startListening()
    }
  }

  function dispose() {
    clearAttachRetry(true)
    outputPerf?.dispose()
    outputPerf = null
    disposal.dispose()
  }

  return {
    startListening,
    pause,
    dispose,
    redraw,
    ensureConnected,
  }
}
