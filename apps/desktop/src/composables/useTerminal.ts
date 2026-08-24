import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { openUrl } from "@tauri-apps/plugin-opener"
import { isTauri } from "../tauri-mock"
import { useThemeRuntime } from "../theme/runtime"
import { getSharedStreamClient } from "./desktopStreamClient"
import type { StreamClient } from "@kanna/stream-client"
import { useToast } from "./useToast"
import { createTerminalInputQueue } from "./terminalInputQueue"
import { createTerminalClipboardBridge } from "./terminalClipboardBridge"
import { initializeTerminalView } from "./terminalView"
import type { TerminalFileMentionList, TerminalFileMention } from "./terminalFileLinks"
import { createTerminalLayoutController } from "./terminalLayout"
import { createTerminalRuntimeState } from "./terminalRuntimeState"
import { createTerminalSessionLifecycle } from "./terminalSessionLifecycle"
import type { SpawnOptions, TerminalOptions } from "./terminalTypes"
import { debugLog } from "../utils/debugLog"

export type { SpawnOptions, TerminalOptions } from "./terminalTypes"

const IMAGE_LINK_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i

export function resetTerminalOutputSubscriptionsForTests(): void {
  // Kept as a compatibility test hook; terminal output no longer uses Tauri
  // event subscriptions after the KSP migration.
}

function isImageLinkUri(uri: string): boolean {
  return IMAGE_LINK_EXTENSION.test(uri)
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions, options?: TerminalOptions) {
  const { effectiveCodeTheme } = useThemeRuntime()
  const toast = useToast()
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  const instanceId = Math.random().toString(36).slice(2, 10)
  const outputDecoder = new TextDecoder()
  const state = createTerminalRuntimeState()

  function handleLinkActivate(_event: MouseEvent, uri: string) {
    if (isImageLinkUri(uri)) {
      document.dispatchEvent(new CustomEvent("image-link-activate", {
        detail: { url: uri },
      }))
      return
    }

    if (isTauri) {
      openUrl(uri).catch((e) => console.error("[terminal] Failed to open URL:", e))
    } else {
      window.open(uri, "_blank")
    }
  }

  async function getTerminalStreamClient(): Promise<StreamClient> {
    state.streamClient ??= await getSharedStreamClient()
    return state.streamClient
  }

  const sendGenericTerminalInput = async (
    nativeSessionId: string,
    dataB64: string,
    submissionBoundary = false,
    controlInput = false,
  ) => {
    const client = await getTerminalStreamClient()
    client.sendTermInput(nativeSessionId, dataB64, submissionBoundary, controlInput)
  }
  const inputQueue = createTerminalInputQueue({
    sessionId,
    getSendTerminalInput: () => sendGenericTerminalInput,
  })
  const clipboardBridge = createTerminalClipboardBridge({
    sessionId,
    instanceId,
    options,
    outputDecoder,
    sendInputBytes: inputQueue.sendInputBytes,
  })
  const layout = createTerminalLayoutController({
    sessionId,
    instanceId,
    state,
    terminal,
    fitAddon,
    options,
    getContainer: () => state.container,
    getTerminalStreamClient,
  })
  const lifecycle = createTerminalSessionLifecycle({
    sessionId,
    instanceId,
    state,
    terminal,
    spawnOptions,
    options,
    inputQueue,
    clipboardBridge,
    layout,
    toast,
    getTerminalStreamClient,
  })

  function init(el: HTMLElement) {
    state.container = el
    debugLog("[terminal][instance] init", {
      sessionId,
      instanceId,
      worktreePath: options?.worktreePath ?? null,
      agentProvider: options?.agentProvider ?? null,
    })
    state.stopThemeWatch?.()
    state.terminalView?.stopFileLinkAvailabilityWatch()
    state.terminalView?.unregisterFileLinkProvider()
    state.terminalView?.unregisterE2ETerminalBuffer()
    state.terminalView = initializeTerminalView({
      el,
      sessionId,
      instanceId,
      options,
      effectiveCodeTheme,
      fitAddon,
      getContainer: () => state.container,
      isDisposed: () => state.disposed,
      isAttached: () => state.attached,
      getStreamClient: () => state.streamClient,
      handleLinkActivate,
      sendInputBytes: inputQueue.sendInputBytes,
      maybeReadClipboardImage: clipboardBridge.maybeReadClipboardImage,
      sendDroppedPaths: clipboardBridge.sendDroppedPaths,
      onNativeDropCleanupReady: (cleanup) => {
        state.cleanupNativeDropEvents = cleanup
      },
      setTerminal: (term) => {
        terminal.value = term
      },
    })
    state.cleanupContainerEvents = state.terminalView.cleanupContainerEvents
    state.stopThemeWatch = state.terminalView.stopThemeWatch
  }

  async function listMentionedFiles(): Promise<TerminalFileMentionList> {
    return await state.terminalView?.fileLinkProvider.listMentions()
      ?? { mentions: [], overflow: false }
  }

  function activateMentionedFile(mention: TerminalFileMention): void {
    state.terminalView?.fileLinkProvider.activateMention(mention)
  }

  onUnmounted(() => {
    lifecycle.dispose()
  })

  return {
    terminal,
    init,
    startListening: lifecycle.startListening,
    fit: layout.fit,
    fitDeferred: layout.fitDeferred,
    redraw: lifecycle.redraw,
    ensureConnected: lifecycle.ensureConnected,
    listMentionedFiles,
    activateMentionedFile,
    pause: lifecycle.pause,
    dispose: lifecycle.dispose,
  }
}
