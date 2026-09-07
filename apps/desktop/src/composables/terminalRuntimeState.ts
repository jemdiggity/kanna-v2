import type { Ref } from "vue"
import type { Terminal } from "@xterm/xterm"
import type { StreamClient } from "@kanna/stream-client"
import type { InitializedTerminalView } from "./terminalView"

export interface TerminalRuntimeState {
  unlistenExit: (() => void) | null
  unlistenSessionCreated: (() => void) | null
  unlistenDaemonReady: (() => void) | null
  unlistenStreamLost: (() => void) | null
  unlistenSharedStreamConnection: (() => void) | null
  container: HTMLElement | null
  cleanupContainerEvents: (() => void) | null
  cleanupNativeDropEvents: (() => void) | null
  stopThemeWatch: (() => void) | null
  terminalView: InitializedTerminalView | null
  fitRafId: number
  attached: boolean
  terminalStreamAttached: boolean
  connecting: boolean
  paused: boolean
  connectionGeneration: number
  disposed: boolean
  hasAttachedOnce: boolean
  sessionExited: boolean
  pendingSessionCreatedRebind: boolean
  connectSpawnedSession: boolean
  preserveRecoveredScrollbackForNextSnapshot: boolean
  /** A session_created rebind means a new PTY now backs this session id (a
   * stage-swap respawn): whatever xterm shows is the dead incarnation's, and
   * the next snapshot must replace it — even for providers whose ordinary
   * reconnects skip the reset — or the carried-over history it now opens with
   * would render below the stale copy and read twice. */
  resetTerminalOnNextSnapshot: boolean
  streamClient: StreamClient | null
  respawningAfterAttachFailure: boolean
  attachFailureMessage: string | null
  attachRetryAttempt: number
  attachRetryTimer: ReturnType<typeof setTimeout> | null
  /** Hydrating an authoritative snapshot must not echo a resize proposal. */
  applyingSnapshot: boolean
}

export function createTerminalRuntimeState(): TerminalRuntimeState {
  return {
    unlistenExit: null,
    unlistenSessionCreated: null,
    unlistenDaemonReady: null,
    unlistenStreamLost: null,
    unlistenSharedStreamConnection: null,
    container: null,
    cleanupContainerEvents: null,
    cleanupNativeDropEvents: null,
    stopThemeWatch: null,
    terminalView: null,
    fitRafId: 0,
    attached: false,
    terminalStreamAttached: false,
    connecting: false,
    paused: false,
    connectionGeneration: 0,
    disposed: false,
    hasAttachedOnce: false,
    sessionExited: false,
    pendingSessionCreatedRebind: false,
    connectSpawnedSession: false,
    preserveRecoveredScrollbackForNextSnapshot: false,
    resetTerminalOnNextSnapshot: false,
    streamClient: null,
    respawningAfterAttachFailure: false,
    attachFailureMessage: null,
    attachRetryAttempt: 0,
    attachRetryTimer: null,
    applyingSnapshot: false,
  }
}

export function getLiveTerminal(
  state: TerminalRuntimeState,
  terminal: Ref<Terminal | null>,
): Terminal | null {
  return state.disposed ? null : terminal.value
}

export function isCurrentListeningGeneration(
  state: TerminalRuntimeState,
  generation: number,
): boolean {
  return !state.paused && !state.disposed && generation === state.connectionGeneration
}

export function acceptRegisteredListener(params: {
  state: TerminalRuntimeState
  generation: number
  event: string
  unlisten: () => void
  sessionId: string
  instanceId: string
}): boolean {
  if (isCurrentListeningGeneration(params.state, params.generation)) {
    console.warn("[terminal][instance] listener:add", {
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      event: params.event,
    })
    return true
  }

  params.unlisten()
  console.warn("[terminal][instance] listener:remove", {
    sessionId: params.sessionId,
    instanceId: params.instanceId,
    event: params.event,
    reason: "late-registration",
  })
  return false
}
