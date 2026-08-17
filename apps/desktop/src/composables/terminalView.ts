import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { ImageAddon } from "@xterm/addon-image"
import { WebglAddon } from "@xterm/addon-webgl"
import { watch, type Ref } from "vue"
import type { StreamClient } from "@kanna/stream-client"
import { getTerminalTheme, type ResolvedTheme } from "../theme/theme"
import { registerE2ETerminalBuffer } from "../e2eTerminalBuffers"
import { isAppShortcut } from "./useKeyboardShortcuts"
import { shouldPushKittyKeyboardOnFreshAttach, shouldSupportKittyKeyboard } from "./terminalSessionRecovery"
import type { TerminalOptions } from "./terminalTypes"
import { createTerminalFileLinkProvider, type TerminalFileLinkProvider } from "./terminalFileLinks"
import { registerTerminalFileLinkProvider } from "./terminalFileLinkRegistry"
import { createTerminalDropBridge, type TerminalDropBridge } from "./terminalDropBridge"
import { isShiftEnter, SHIFT_ENTER_CSI_U } from "./terminalKeyboard"

export interface InitializedTerminalView {
  term: Terminal
  cleanupContainerEvents: (() => void) | null
  stopThemeWatch: () => void
  unregisterE2ETerminalBuffer: () => void
  unregisterFileLinkProvider: () => void
  stopFileLinkAvailabilityWatch: () => void
  fileLinkProvider: TerminalFileLinkProvider
  dropBridge: TerminalDropBridge
}

export function initializeTerminalView(params: {
  el: HTMLElement
  sessionId: string
  instanceId: string
  options?: TerminalOptions
  effectiveCodeTheme: Ref<ResolvedTheme>
  fitAddon: FitAddon
  getContainer: () => HTMLElement | null
  isDisposed: () => boolean
  isAttached: () => boolean
  getStreamClient: () => StreamClient | null
  handleLinkActivate: (event: MouseEvent, uri: string) => void
  sendInputBytes: (
    bytes: Uint8Array,
    config?: { immediate?: boolean; submissionBoundary?: boolean; controlInput?: boolean },
  ) => Promise<void>
  maybeReadClipboardImage: () => Promise<void>
  sendDroppedPaths: (paths: string[]) => void
  onNativeDropCleanupReady: (cleanup: () => void) => void
  setTerminal: (term: Terminal) => void
}): InitializedTerminalView {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1,
    linkHandler: { activate: params.handleLinkActivate },
    theme: getTerminalTheme(params.effectiveCodeTheme.value),
    scrollback: 10000,
    cursorBlink: false,
    ...(shouldSupportKittyKeyboard(params.options) ? { vtExtensions: { kittyKeyboard: true } } : {}),
  })
  term.loadAddon(params.fitAddon)
  term.loadAddon(new WebLinksAddon(params.handleLinkActivate))
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      console.warn("[terminal] WebGL context lost, falling back to DOM renderer")
      webgl.dispose()
    })
    term.loadAddon(webgl)
  } catch (e) {
    console.warn("[terminal] WebGL addon failed, falling back to DOM renderer:", e)
  }
  term.loadAddon(new ImageAddon())

  const fileLinkProvider = createTerminalFileLinkProvider({
    term,
    options: params.options,
    getContainer: params.getContainer,
  })
  fileLinkProvider.register()
  const unregisterFileLinkProvider = params.options?.worktreePath && params.options?.agentTerminal
    ? registerTerminalFileLinkProvider(params.sessionId, {
        activateLatest: () => fileLinkProvider.activateLatest(),
      })
    : () => {}
  const stopFileLinkAvailabilityWatch = params.options?.worktreePath && params.options?.agentTerminal
    ? fileLinkProvider.watchForFirstLink(() => {
        params.getContainer()?.dispatchEvent(new CustomEvent("terminal-file-link-available", {
          bubbles: true,
        }))
      })
    : () => {}

  term.open(params.el)

  const dropBridge = createTerminalDropBridge({
    sessionId: params.sessionId,
    instanceId: params.instanceId,
    options: params.options,
    getContainer: params.getContainer,
    isDisposed: params.isDisposed,
    sendDroppedPaths: params.sendDroppedPaths,
    onNativeDropCleanupReady: params.onNativeDropCleanupReady,
  })
  const cleanupDropEvents = dropBridge.registerContainerDropHandlers()
  type ProducerInputKind = "draft" | "submission" | "control"
  // xterm emits protocol replies through `onData` without a DOM input event.
  // Treat that unclassified path as terminal control; every human input path
  // below declares itself before xterm emits its bytes.
  let producerInputKind: ProducerInputKind = "control"
  let producerInputGeneration = 0
  const declareProducerInput = (kind: ProducerInputKind) => {
    producerInputKind = kind
    const generation = ++producerInputGeneration
    queueMicrotask(() => {
      if (producerInputGeneration === generation) producerInputKind = "control"
    })
  }
  const declareControlInput = () => declareProducerInput("control")
  const declareDraftInput = () => declareProducerInput("draft")
  const controlEvents = ["mousedown", "mouseup", "mousemove", "wheel", "focus", "blur"]
  const draftEvents = ["beforeinput", "paste", "compositionstart", "compositionupdate", "compositionend"]
  for (const eventName of controlEvents) {
    params.el.addEventListener(eventName, declareControlInput, true)
  }
  for (const eventName of draftEvents) {
    params.el.addEventListener(eventName, declareDraftInput, true)
  }
  const cleanupContainerEvents = () => {
    cleanupDropEvents?.()
    for (const eventName of controlEvents) {
      params.el.removeEventListener(eventName, declareControlInput, true)
    }
    for (const eventName of draftEvents) {
      params.el.removeEventListener(eventName, declareDraftInput, true)
    }
  }

  if (params.el.offsetWidth > 0 && params.el.offsetHeight > 0) {
    params.fitAddon.fit()
  }

  if (params.options?.kittyKeyboard && shouldPushKittyKeyboardOnFreshAttach(params.options)) {
    term.write("\x1b[>1u")
  }

  // Let app-level shortcuts pass through even when terminal has focus,
  // but always let Escape reach the terminal (needed for Claude CLI).
  // In kitty keyboard mode, Cmd+C/V would be encoded as CSI sequences
  // and sent to the PTY instead of triggering clipboard operations —
  // intercept Cmd+C here and let Cmd+V fall through to the native paste event.
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type === "keydown") {
      declareProducerInput(
        e.key === "Enter"
          && !e.isComposing
          && !e.shiftKey
          && !e.altKey
          && !e.ctrlKey
          && !e.metaKey
          ? "submission"
          : "draft",
      )
    }
    if (
      params.options?.agentTerminal &&
      isShiftEnter(e)
    ) {
      e.preventDefault()
      void params.sendInputBytes(new TextEncoder().encode(SHIFT_ENTER_CSI_U), { immediate: true })
      return false
    }
    if (e.key === "Escape") {
      // If this terminal is inside a modal (e.g. ShellModal), consume Escape for the PTY.
      // Otherwise, when a modal overlay is visible, let Escape bubble to dismiss it.
      if (params.getContainer()?.closest('.modal-overlay')) return true
      if (document.querySelector('.modal-overlay')) return false
      return true
    }
    if (isAppShortcut(e)) return false
    // Prevent kitty keyboard from encoding Cmd+key as CSI sequences —
    // let them fall through to the OS/browser (Cmd+Q, Cmd+V, etc.).
    // Cmd+C is special: copy the terminal selection to clipboard.
    if (e.type === "keydown" && e.metaKey) {
      if (e.key === "c" && !e.altKey && !e.ctrlKey) {
        const sel = term.getSelection()
        if (sel) navigator.clipboard.writeText(sel)
        e.preventDefault()
      }
      if (params.options?.agentTerminal && e.key === "v" && !e.altKey && !e.ctrlKey) {
        void params.maybeReadClipboardImage()
      }
      return false
    }
    return true
  })

  // Send keystrokes to daemon
  term.onData((data) => {
    void params.sendInputBytes(new TextEncoder().encode(data), {
      submissionBoundary: producerInputKind === "submission",
      controlInput: producerInputKind === "control",
    })
  })

  // Handle resize — only forward to daemon after session is attached,
  // otherwise the invoke fails silently and the resize is lost.
  term.onResize(({ cols, rows }) => {
    if (params.isAttached()) {
      params.getStreamClient()?.sendTermResize(params.sessionId, cols, rows)
    }
  })

  params.setTerminal(term)
  const stopThemeWatch = watch(params.effectiveCodeTheme, (theme) => {
    term.options.theme = getTerminalTheme(theme)
  })
  const unregisterE2ETerminalBuffer = registerE2ETerminalBuffer(params.sessionId, term)

  return {
    term,
    cleanupContainerEvents,
    stopThemeWatch,
    unregisterE2ETerminalBuffer,
    unregisterFileLinkProvider,
    stopFileLinkAvailabilityWatch,
    fileLinkProvider,
    dropBridge,
  }
}
