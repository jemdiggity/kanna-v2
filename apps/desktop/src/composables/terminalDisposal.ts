import type { Ref } from "vue"
import type { Terminal } from "@xterm/xterm"
import { shouldRunTerminalDispose } from "./terminalSessionRecovery"
import type { TerminalInputQueue } from "./terminalInputQueue"
import type { TerminalClipboardBridge } from "./terminalClipboardBridge"
import type { TerminalLayoutController } from "./terminalLayout"
import type { TerminalRuntimeState } from "./terminalRuntimeState"

export function createTerminalDisposalController(params: {
  sessionId: string
  instanceId: string
  state: TerminalRuntimeState
  terminal: Ref<Terminal | null>
  inputQueue: TerminalInputQueue
  clipboardBridge: TerminalClipboardBridge
  layout: TerminalLayoutController
}) {
  function dispose() {
    if (!shouldRunTerminalDispose(params.state.disposed)) return
    console.warn("[terminal][instance] dispose:start", {
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      attached: params.state.attached,
      connecting: params.state.connecting,
      hasAttachedOnce: params.state.hasAttachedOnce,
      hasExitListener: params.state.unlistenExit != null,
      hasDaemonReadyListener: params.state.unlistenDaemonReady != null,
      hasStreamLostListener: params.state.unlistenStreamLost != null,
    })
    void params.inputQueue.flushQueuedInput()
    if (params.state.attached || params.state.connecting || params.state.hasAttachedOnce) {
      params.state.streamClient?.detach(params.sessionId, "terminal")
    }
    params.state.disposed = true
    params.state.attached = false
    params.state.terminalStreamAttached = false
    params.state.terminalView?.fileLinkProvider.clearFileExistsCache()
    params.layout.cancelPendingFit()
    params.inputQueue.clearPendingInputFlushTimer()
    params.state.cleanupContainerEvents?.()
    params.state.cleanupContainerEvents = null
    params.state.cleanupNativeDropEvents?.()
    params.state.cleanupNativeDropEvents = null
    params.state.stopThemeWatch?.()
    params.state.stopThemeWatch = null
    params.state.terminalView?.unregisterE2ETerminalBuffer()
    params.state.terminalView?.dropBridge.resetNativeDropDedupe()
    params.state.terminalView = null
    params.clipboardBridge.reset()
    if (params.state.unlistenExit) {
      params.state.unlistenExit()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "session_exit",
      })
    }
    if (params.state.unlistenDaemonReady) {
      params.state.unlistenDaemonReady()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "daemon_ready",
      })
    }
    if (params.state.unlistenStreamLost) {
      params.state.unlistenStreamLost()
      console.warn("[terminal][instance] listener:remove", {
        sessionId: params.sessionId,
        instanceId: params.instanceId,
        event: "session_stream_lost",
      })
    }
    if (params.state.unlistenSharedStreamConnection) {
      params.state.unlistenSharedStreamConnection()
    }
    params.terminal.value?.dispose()
    params.terminal.value = null
    params.state.unlistenExit = null
    params.state.unlistenDaemonReady = null
    params.state.unlistenStreamLost = null
    params.state.unlistenSharedStreamConnection = null
    params.state.container = null
    console.warn("[terminal][instance] dispose:end", {
      sessionId: params.sessionId,
      instanceId: params.instanceId,
    })
  }

  return { dispose }
}
