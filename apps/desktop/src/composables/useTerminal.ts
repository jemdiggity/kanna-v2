import { ref, onUnmounted, watch } from "vue"
import { Terminal, type ILink } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { ImageAddon } from "@xterm/addon-image"
import { WebglAddon } from "@xterm/addon-webgl"
import { openUrl } from "@tauri-apps/plugin-opener"
import { invoke } from "../invoke"
import { listen } from "../listen"
import { isTauri } from "../tauri-mock"
import {
  loadSessionRecoveryState,
  shouldApplyRecoverySnapshot,
} from "./sessionRecoveryState"
import { isAppShortcut } from "./useKeyboardShortcuts"
import {
  formatAttachFailureMessage,
  formatMissingInitialTaskSessionMessage,
  getRespawnToastKey,
  getReconnectRedrawPolicy,
  getReconnectResizeDelayMs,
  getReconnectKeyboardPush,
  getTerminalRecoveryMode,
  isMissingDaemonSessionFailure,
  shouldRespawnAfterAttachFailure,
  shouldPushKittyKeyboardOnFreshAttach,
  shouldRestoreRecoveryState,
  shouldRunTerminalDispose,
  shouldSupportKittyKeyboard,
  shouldSkipReconnect,
  shouldForceDoubleResizeOnReconnect,
  shouldReattachOnDaemonReady,
} from "./terminalSessionRecovery"
import {
  buildKittyClipboardResponse,
  collectKittyClipboardRequests,
  type ClipboardImagePayload,
  encodeTerminalPasteBytes,
  formatDroppedPathsForPaste,
  updateBracketedPasteMode,
} from "./terminalMediaBridge"
import { useToast } from "./useToast"
import i18n from "../i18n"
import { getAppErrorMessage } from "../appError"
import { markTaskSwitchFirstOutput } from "../perf/taskSwitchPerf"
import { registerE2ETerminalBuffer } from "../e2eTerminalBuffers"
import { hasObservedDaemonReady, markDaemonReadyObserved } from "./daemonReadyState"
import { getTerminalTheme } from "../theme/theme"
import { useThemeRuntime } from "../theme/runtime"

export interface SpawnOptions {
  cwd: string
  prompt: string
  spawnFn: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>
}

export interface TerminalOptions {
  kittyKeyboard?: boolean
  agentProvider?: string
  worktreePath?: string
  agentTerminal?: boolean
  skipInitialReconnectEffects?: boolean
}

const CLIPBOARD_IMAGE_TTL_MS = 30_000
const NATIVE_DROP_DEDUPE_WINDOW_MS = 100
const INPUT_BATCH_WINDOW_MS = 8
const BRACKETED_PASTE_CONTROL_SEQUENCE = /\u001b\[\?2004[hl]/

interface TerminalOutputPayload {
  session_id?: string
  data_b64?: string
  data?: unknown
}

interface TauriEventPayload<T> {
  payload?: T
}

type TerminalOutputHandler = (payload: TerminalOutputPayload) => void
type TerminalOutputEvent = TauriEventPayload<TerminalOutputPayload> | TerminalOutputPayload

const terminalOutputSubscribers = new Map<string, Set<TerminalOutputHandler>>()
let unlistenSharedTerminalOutput: (() => void) | null = null
let sharedTerminalOutputListenPromise: Promise<void> | null = null

function hasEventPayload(event: TerminalOutputEvent): event is TauriEventPayload<TerminalOutputPayload> {
  return Object.prototype.hasOwnProperty.call(event, "payload")
}

function payloadFromTerminalOutputEvent(event: TerminalOutputEvent): TerminalOutputPayload {
  if (hasEventPayload(event)) {
    return event.payload ?? {}
  }
  return event
}

function terminalOutputSubscriberCount(): number {
  let count = 0
  for (const handlers of terminalOutputSubscribers.values()) {
    count += handlers.size
  }
  return count
}

function isByteArray(data: unknown): data is number[] {
  return Array.isArray(data) && data.every((value) => typeof value === "number")
}

async function ensureSharedTerminalOutputListener(): Promise<void> {
  if (unlistenSharedTerminalOutput || sharedTerminalOutputListenPromise) {
    return sharedTerminalOutputListenPromise ?? Promise.resolve()
  }

  sharedTerminalOutputListenPromise = listen(
    "terminal_output",
    (event: TerminalOutputEvent) => {
      const payload = payloadFromTerminalOutputEvent(event)
      const sid = payload.session_id
      if (!sid) return
      const handlers = terminalOutputSubscribers.get(sid)
      if (!handlers) return
      for (const handler of [...handlers]) {
        handler(payload)
      }
    },
  ).then((unlisten) => {
    unlistenSharedTerminalOutput = () => {
      unlisten()
      unlistenSharedTerminalOutput = null
      sharedTerminalOutputListenPromise = null
    }
    if (terminalOutputSubscriberCount() === 0) {
      unlistenSharedTerminalOutput()
    }
  }).catch((error) => {
    sharedTerminalOutputListenPromise = null
    console.warn("[terminal][event] failed to register shared terminal_output listener", error)
  })

  return sharedTerminalOutputListenPromise
}

async function subscribeTerminalOutput(
  sessionIds: readonly string[],
  handler: TerminalOutputHandler,
): Promise<() => void> {
  for (const sid of sessionIds) {
    const handlers = terminalOutputSubscribers.get(sid) ?? new Set<TerminalOutputHandler>()
    handlers.add(handler)
    terminalOutputSubscribers.set(sid, handlers)
  }

  let active = true
  const unsubscribe = () => {
    if (!active) return
    active = false
    for (const sid of sessionIds) {
      const handlers = terminalOutputSubscribers.get(sid)
      if (!handlers) continue
      handlers.delete(handler)
      if (handlers.size === 0) {
        terminalOutputSubscribers.delete(sid)
      }
    }
    if (terminalOutputSubscriberCount() === 0 && unlistenSharedTerminalOutput) {
      unlistenSharedTerminalOutput()
    }
  }

  await ensureSharedTerminalOutputListener()
  if (!active) {
    unsubscribe()
  }

  return unsubscribe
}

export function resetTerminalOutputSubscriptionsForTests(): void {
  terminalOutputSubscribers.clear()
  if (unlistenSharedTerminalOutput) {
    unlistenSharedTerminalOutput()
  }
  unlistenSharedTerminalOutput = null
  sharedTerminalOutputListenPromise = null
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions, options?: TerminalOptions) {
  const toast = useToast()
  const { effectiveCodeTheme } = useThemeRuntime()
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  const instanceId = Math.random().toString(36).slice(2, 10)
  const outputDecoder = new TextDecoder()
  interface RecoverySnapshotFetchResult {
    snapshot: Awaited<ReturnType<typeof loadSessionRecoveryState>>
    failed: boolean
  }
  interface TerminalSnapshotEventPayload {
    session_id: string
    snapshot: {
      version: number
      rows: number
      cols: number
      cursor_row: number
      cursor_col: number
      cursor_visible: boolean
      vt: string
    }
  }
  let unlistenOutput: (() => void) | null = null
  let unlistenSnapshot: (() => void) | null = null
  let unlistenExit: (() => void) | null = null
  let unlistenDaemonReady: (() => void) | null = null
  let unlistenStreamLost: (() => void) | null = null
  let unregisterE2ETerminalBuffer: (() => void) | null = null
  let container: HTMLElement | null = null
  let cleanupContainerEvents: (() => void) | null = null
  let cleanupNativeDropEvents: (() => void) | null = null
  let stopThemeWatch: (() => void) | null = null
  let fitRafId = 0
  let pendingInputFlushTimer: ReturnType<typeof setTimeout> | null = null
  let pendingInputBytes: number[] = []
  let inputWriteChain: Promise<void> = Promise.resolve()
  let inputWriteInFlight = false
  let attached = false
  let connecting = false
  let paused = false
  let connectionGeneration = 0
  let disposed = false
  let hasAttachedOnce = false
  let sessionExited = false
  let preserveRecoveredScrollbackForNextSnapshot = false
  let bracketedPasteMode = false
  let hasObservedBracketedPasteMode = false
  let kittyClipboardBuffer = ""
  let pendingClipboardImage: ClipboardImagePayload | null = null
  let pendingClipboardImageExpiresAt = 0
  let pendingClipboardImageLoad: Promise<ClipboardImagePayload | null> | null = null
  let lastNativeDropSignature: string | null = null
  let lastNativeDropAt = 0

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

  // --- File link provider ---
  const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z0-9_.\-][\w.\-/]*\/[\w.\-/]*\.[a-zA-Z0-9]+(?::\d+)?)/g
  const fileExistsCache = new Map<string, boolean>()

  function parseFileLink(raw: string): { path: string; line?: number } {
    const colonIdx = raw.lastIndexOf(":")
    if (colonIdx > 0) {
      const maybeLine = raw.slice(colonIdx + 1)
      if (/^\d+$/.test(maybeLine)) {
        return { path: raw.slice(0, colonIdx), line: parseInt(maybeLine, 10) }
      }
    }
    return { path: raw }
  }

  async function checkFileExists(relativePath: string): Promise<boolean> {
    const worktreePath = options?.worktreePath
    if (!worktreePath) return false
    if (fileExistsCache.has(relativePath)) return fileExistsCache.get(relativePath)!
    try {
      const exists = await invoke<boolean>("file_exists", { path: `${worktreePath}/${relativePath}` })
      fileExistsCache.set(relativePath, exists)
      return exists
    } catch (error) {
      console.debug("[terminal] failed to check file existence; caching false:", { relativePath, error })
      fileExistsCache.set(relativePath, false)
      return false
    }
  }

  function clearPendingClipboardImage() {
    pendingClipboardImage = null
    pendingClipboardImageExpiresAt = 0
  }

  function getPendingClipboardImage(): ClipboardImagePayload | null {
    if (!pendingClipboardImage) {
      return null
    }
    if (Date.now() > pendingClipboardImageExpiresAt) {
      clearPendingClipboardImage()
      return null
    }
    return pendingClipboardImage
  }

  function armPendingClipboardImage(payload: ClipboardImagePayload) {
    pendingClipboardImage = payload
    pendingClipboardImageExpiresAt = Date.now() + CLIPBOARD_IMAGE_TTL_MS
  }

  async function sendInputBytesNow(bytes: Uint8Array) {
    await invoke("send_input", {
      sessionId,
      data: Array.from(bytes),
    })
  }

  function queueInputWrite(bytes: Uint8Array): Promise<void> {
    const runWrite = async () => {
      inputWriteInFlight = true
      try {
        await sendInputBytesNow(bytes)
      } finally {
        inputWriteInFlight = false
      }
    }

    if (!inputWriteInFlight && pendingInputBytes.length === 0 && !pendingInputFlushTimer) {
      inputWriteChain = runWrite()
      return inputWriteChain
    }

    inputWriteChain = inputWriteChain
      .catch((error) => {
        console.debug("[terminal] previous queued input write failed; continuing queue:", { sessionId, error })
      })
      .then(runWrite)
    return inputWriteChain
  }

  function flushQueuedInput(): Promise<void> {
    if (pendingInputFlushTimer) {
      clearTimeout(pendingInputFlushTimer)
      pendingInputFlushTimer = null
    }
    if (pendingInputBytes.length === 0) {
      return inputWriteChain
    }
    const bytes = new Uint8Array(pendingInputBytes)
    pendingInputBytes = []
    return queueInputWrite(bytes)
  }

  function queueInputBytes(bytes: Uint8Array): void {
    pendingInputBytes.push(...bytes)
    if (pendingInputFlushTimer) {
      return
    }
    pendingInputFlushTimer = setTimeout(() => {
      pendingInputFlushTimer = null
      void flushQueuedInput()
    }, INPUT_BATCH_WINDOW_MS)
  }

  async function sendInputBytes(bytes: Uint8Array, config?: { immediate?: boolean }) {
    if (config?.immediate) {
      await flushQueuedInput()
      await queueInputWrite(bytes)
      return
    }
    queueInputBytes(bytes)
  }

  async function maybeReadClipboardImage() {
    if (!options?.agentTerminal) {
      return
    }
    const load = (async () => {
      try {
        const payload = await invoke<ClipboardImagePayload | null>("read_clipboard_image_png", {})
        if (!payload) {
          clearPendingClipboardImage()
          return null
        }
        armPendingClipboardImage(payload)
        return payload
      } catch (error) {
        clearPendingClipboardImage()
        console.warn("[terminal][clipboard] failed to read clipboard image", {
          sessionId,
          instanceId,
          error: getAppErrorMessage(error),
        })
        return null
      }
    })()
    pendingClipboardImageLoad = load
    void load.finally(() => {
      if (pendingClipboardImageLoad === load) {
        pendingClipboardImageLoad = null
      }
    })
  }

  async function resolvePendingClipboardImage(): Promise<ClipboardImagePayload | null> {
    const readyPayload = getPendingClipboardImage()
    if (readyPayload) {
      return readyPayload
    }
    if (!pendingClipboardImageLoad) {
      return null
    }
    await pendingClipboardImageLoad
    return getPendingClipboardImage()
  }

  async function maybeRespondToKittyClipboardRequests(requests: ReturnType<typeof collectKittyClipboardRequests>["requests"]) {
    if (requests.length === 0) {
      return
    }

    const payload = await resolvePendingClipboardImage()
    if (!payload) {
      return
    }

    const matchesRequest = requests.some((request) => {
      return request.mimeTypes.length === 0 || request.mimeTypes.includes(payload.mimeType)
    })

    if (!matchesRequest) {
      return
    }

    clearPendingClipboardImage()
    const response = buildKittyClipboardResponse(payload)
    await sendInputBytes(new TextEncoder().encode(response), { immediate: true })
  }

  function handleTerminalOutputControlSequences(bytes: Uint8Array) {
    const chunkText = outputDecoder.decode(bytes, { stream: true })
    if (BRACKETED_PASTE_CONTROL_SEQUENCE.test(chunkText)) {
      hasObservedBracketedPasteMode = true
    }
    bracketedPasteMode = updateBracketedPasteMode(bracketedPasteMode, chunkText)
    kittyClipboardBuffer += chunkText

    const parsed = collectKittyClipboardRequests(kittyClipboardBuffer)
    kittyClipboardBuffer = parsed.remainder
    void maybeRespondToKittyClipboardRequests(parsed.requests).catch((error) => {
      console.warn("[terminal][clipboard] failed to send clipboard image response", {
        sessionId,
        instanceId,
        error: getAppErrorMessage(error),
      })
    })
  }

  function restoreTerminalModesFromSnapshot(serializedTerminalState: string) {
    // AttachSnapshot/recovery snapshots redraw the terminal from a serialized VT stream.
    // Replay the mode toggles embedded in that stream so local paste behavior
    // matches the restored terminal state.
    if (BRACKETED_PASTE_CONTROL_SEQUENCE.test(serializedTerminalState)) {
      hasObservedBracketedPasteMode = true
    }
    bracketedPasteMode = updateBracketedPasteMode(false, serializedTerminalState)
  }

  function shouldUseBracketedPasteForDrop() {
    if (options?.agentProvider === "copilot" && !hasObservedBracketedPasteMode) {
      return true
    }
    return bracketedPasteMode
  }

  function sendDroppedPaths(paths: string[]) {
    if (paths.length === 0) return
    const text = formatDroppedPathsForPaste(paths)
    const bytes = encodeTerminalPasteBytes(text, shouldUseBracketedPasteForDrop())
    void sendInputBytes(bytes, { immediate: true })
  }

  function shouldHandleNativeDrop(paths: string[]) {
    const signature = paths.join("\u0000")
    const now = Date.now()
    if (
      lastNativeDropSignature === signature &&
      now - lastNativeDropAt <= NATIVE_DROP_DEDUPE_WINDOW_MS
    ) {
      return false
    }
    lastNativeDropSignature = signature
    lastNativeDropAt = now
    return true
  }

  function isDropWithinContainer(dropPosition: {
    x?: number
    y?: number
    toLogical?: (scaleFactor: number) => { x: number; y: number }
  }) {
    if (!container) return false
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false

    const candidates = [
      typeof dropPosition.x === "number" && typeof dropPosition.y === "number"
        ? { x: dropPosition.x, y: dropPosition.y }
        : null,
      typeof dropPosition.toLogical === "function"
        ? dropPosition.toLogical(window.devicePixelRatio || 1)
        : null,
      typeof dropPosition.x === "number" && typeof dropPosition.y === "number"
        ? {
            x: dropPosition.x / (window.devicePixelRatio || 1),
            y: dropPosition.y / (window.devicePixelRatio || 1),
          }
        : null,
    ].filter((position): position is { x: number; y: number } => position !== null)

    return candidates.some((position) => {
      return (
        position.x >= rect.left &&
        position.x <= rect.right &&
        position.y >= rect.top &&
        position.y <= rect.bottom
      )
    })
  }

  function init(el: HTMLElement) {
    container = el
    console.warn("[terminal][instance] init", {
      sessionId,
      instanceId,
      worktreePath: options?.worktreePath ?? null,
      agentProvider: options?.agentProvider ?? null,
    })
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1,
      linkHandler: { activate: handleLinkActivate },
      theme: getTerminalTheme(effectiveCodeTheme.value),
      scrollback: 10000,
      cursorBlink: false,
      ...(shouldSupportKittyKeyboard(options) ? { vtExtensions: { kittyKeyboard: true } } : {}),
    })
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon(handleLinkActivate))
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

    if (options?.worktreePath) {
      let tooltipEl: HTMLElement | null = null

      term.registerLinkProvider({
        provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
          const line = term.buffer.active.getLine(bufferLineNumber)
          if (!line) { callback(undefined); return }
          const lineText = line.translateToString(true)

          const matches: { text: string; start: number; path: string }[] = []
          FILE_PATH_RE.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = FILE_PATH_RE.exec(lineText)) !== null) {
            const fullMatch = m[0]
            const pathMatch = m[1]
            const startOffset = m.index + (fullMatch.length - pathMatch.length)
            const { path } = parseFileLink(pathMatch)
            matches.push({ text: pathMatch, start: startOffset, path })
          }

          if (matches.length === 0) { callback(undefined); return }

          Promise.all(matches.map(async (match) => {
            const exists = await checkFileExists(match.path)
            if (!exists) return null
            const link: ILink = {
              range: {
                start: { x: match.start + 1, y: bufferLineNumber },
                end: { x: match.start + match.text.length + 1, y: bufferLineNumber },
              },
              text: match.text,
              activate(event: MouseEvent) {
                if (!event.metaKey) return
                const { path, line: lineNum } = parseFileLink(match.text)
                container?.dispatchEvent(new CustomEvent("file-link-activate", {
                  bubbles: true,
                  detail: { path, line: lineNum },
                }))
              },
              hover(event: MouseEvent) {
                if (!term.element) return
                tooltipEl = document.createElement("div")
                tooltipEl.className = "xterm-hover"
                tooltipEl.textContent = "Open preview (\u2318+click)"
                tooltipEl.style.cssText = `
                  position: fixed;
                  left: ${event.clientX + 8}px;
                  top: ${event.clientY - 28}px;
                  background: var(--kn-bg-panel);
                  color: var(--kn-text-secondary);
                  font-size: 11px;
                  padding: 2px 6px;
                  border-radius: 3px;
                  border: 1px solid var(--kn-border-strong);
                  pointer-events: none;
                  z-index: 10000;
                  font-family: "SF Mono", Menlo, monospace;
                `
                term.element.appendChild(tooltipEl)
              },
              leave() {
                tooltipEl?.remove()
                tooltipEl = null
              },
            }
            return link
          })).then((links) => {
            const valid = links.filter((l): l is ILink => l !== null)
            callback(valid.length > 0 ? valid : undefined)
          })
        },
      })
    }

    term.open(container)

    if (options?.agentTerminal) {
      const suppressDragNavigation = (event: DragEvent) => {
        if ((event.dataTransfer?.files?.length ?? 0) === 0) return
        event.preventDefault()
        event.stopPropagation()
      }

      const handleDrop = (event: DragEvent) => {
        event.preventDefault()
        event.stopPropagation()

        if (isTauri) {
          return
        }

        const files = Array.from(event.dataTransfer?.files ?? [])
        const paths = files
          .map((file) => (file as File & { path?: string }).path ?? "")
          .filter((path): path is string => path.length > 0)

        sendDroppedPaths(paths)
      }

      container.addEventListener("dragenter", suppressDragNavigation)
      container.addEventListener("dragover", suppressDragNavigation)
      container.addEventListener("drop", handleDrop)
      cleanupContainerEvents = () => {
        container?.removeEventListener("dragenter", suppressDragNavigation)
        container?.removeEventListener("dragover", suppressDragNavigation)
        container?.removeEventListener("drop", handleDrop)
      }

      if (isTauri) {
        void Promise.all([
          import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
            return getCurrentWindow().onDragDropEvent((event) => {
              if (event.payload.type !== "drop") return
              if (!isDropWithinContainer(event.payload.position)) return
              if (!shouldHandleNativeDrop(event.payload.paths)) return
              sendDroppedPaths(event.payload.paths)
            })
          }),
          import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
            return getCurrentWebview().onDragDropEvent((event) => {
              if (event.payload.type !== "drop") return
              if (!isDropWithinContainer(event.payload.position)) return
              if (!shouldHandleNativeDrop(event.payload.paths)) return
              sendDroppedPaths(event.payload.paths)
            })
          }),
        ]).then((unlisteners) => {
          const cleanup = () => {
            for (const unlisten of unlisteners) {
              unlisten()
            }
          }

          if (disposed) {
            cleanup()
            return
          }
          cleanupNativeDropEvents = cleanup
        }).catch((error) => {
          console.warn("[terminal][drop] failed to register native drag-drop listener", {
            sessionId,
            instanceId,
            error: getAppErrorMessage(error),
          })
        })
      }
    }

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }

    if (options?.kittyKeyboard && shouldPushKittyKeyboardOnFreshAttach(options)) {
      term.write("\x1b[>1u")
    }

    // Let app-level shortcuts pass through even when terminal has focus,
    // but always let Escape reach the terminal (needed for Claude CLI).
    // In kitty keyboard mode, Cmd+C/V would be encoded as CSI sequences
    // and sent to the PTY instead of triggering clipboard operations —
    // intercept Cmd+C here and let Cmd+V fall through to the native paste event.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (
        options?.agentTerminal &&
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.ctrlKey
      ) {
        e.preventDefault()
        void sendInputBytes(new TextEncoder().encode("\x1b[13;2u"), { immediate: true })
        return false
      }
      if (e.key === "Escape") {
        // If this terminal is inside a modal (e.g. ShellModal), consume Escape for the PTY.
        // Otherwise, when a modal overlay is visible, let Escape bubble to dismiss it.
        if (container?.closest('.modal-overlay')) return true
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
        if (options?.agentTerminal && e.key === "v" && !e.altKey && !e.ctrlKey) {
          void maybeReadClipboardImage()
        }
        return false
      }
      return true
    })

    // Send keystrokes to daemon
    term.onData((data) => {
      void sendInputBytes(new TextEncoder().encode(data))
    })

    // Handle resize — only forward to daemon after session is attached,
    // otherwise the invoke fails silently and the resize is lost.
    term.onResize(({ cols, rows }) => {
      if (attached) {
        invoke("resize_session", { sessionId, cols, rows })
      }
    })

    terminal.value = term
    stopThemeWatch?.()
    stopThemeWatch = watch(effectiveCodeTheme, (theme) => {
      if (terminal.value) {
        terminal.value.options.theme = getTerminalTheme(theme)
      }
    })
    unregisterE2ETerminalBuffer?.()
    unregisterE2ETerminalBuffer = registerE2ETerminalBuffer(sessionId, term)
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
    if (forceDouble) {
      const shrinkCols = Math.max(1, cols - 1)
      console.warn("[terminal][connect] resize:double", {
        sessionId,
        instanceId,
        cols,
        rows,
      })
      await invoke("resize_session", { sessionId, cols: shrinkCols, rows }).catch((error) => {
        console.debug("[terminal][connect] shrink resize failed:", { sessionId, error })
      })
      await invoke("resize_session", { sessionId, cols, rows }).catch((error) => {
        console.debug("[terminal][connect] restore resize failed:", { sessionId, error })
      })
      return
    }

    console.warn("[terminal][connect] resize:single", {
      sessionId,
      instanceId,
      cols,
      rows,
    })
    await invoke("resize_session", { sessionId, cols, rows }).catch((error) => {
      console.debug("[terminal][connect] resize failed:", { sessionId, error })
    })
  }

  async function fetchDaemonSnapshot(): Promise<RecoverySnapshotFetchResult> {
    try {
      console.warn("[terminal][recovery] fetch:start", {
        sessionId,
        attached,
        connecting,
        hasAttachedOnce,
      })
      const snapshot = await loadSessionRecoveryState(sessionId)
      console.warn("[terminal][recovery] fetch:done", {
        sessionId,
        hasSnapshot: snapshot != null,
        cols: snapshot?.cols ?? null,
        rows: snapshot?.rows ?? null,
        sequence: snapshot?.sequence ?? null,
        serializedLength: snapshot?.serialized.length ?? null,
      })
      return { snapshot, failed: false }
    } catch (error) {
      console.error("[terminal] Failed to load recovery snapshot:", error)
      return { snapshot: null, failed: true }
    }
  }

  async function taskWorktreeExists(): Promise<boolean> {
    const worktreePath = options?.worktreePath
    if (!worktreePath) return false
    try {
      return await invoke<boolean>("file_exists", { path: worktreePath })
    } catch (error) {
      console.warn("[terminal][connect] worktree existence check failed", {
        sessionId,
        worktreePath,
        error: getAppErrorMessage(error),
      })
      return false
    }
  }

  async function applyRecoveryStateIfNeeded(
    recoveryState: Awaited<ReturnType<typeof loadSessionRecoveryState>>,
    shouldApplyReconnectEffects: boolean,
  ): Promise<boolean> {
    if (
      !terminal.value ||
      !shouldApplyReconnectEffects ||
      !recoveryState ||
      !shouldApplyRecoverySnapshot(recoveryState, {
        cols: terminal.value.cols,
        rows: terminal.value.rows,
      })
    ) {
      return false
    }

    const applyStartedAt = performance.now()
    console.warn("[terminal][connect] recovery:apply", {
      sessionId,
      sequence: recoveryState.sequence,
      serializedLength: recoveryState.serialized.length,
    })
    const recoveryTerminal = terminal.value
    recoveryTerminal.reset()
    restoreTerminalModesFromSnapshot(recoveryState.serialized)
    recoveryTerminal.write(recoveryState.serialized, () => {
      console.warn("[terminal][connect] recovery:applied", {
        sessionId,
        durationMs: Math.round(performance.now() - applyStartedAt),
        sequence: recoveryState.sequence,
      })
    })
    return true
  }

  async function connectSession() {
    if (paused) return
    if (sessionExited) return
    if (shouldSkipReconnect(connecting, attached)) return
    const generation = connectionGeneration
    connecting = true
    const recoveryMode = getTerminalRecoveryMode(spawnOptions, options)
    const shouldApplyReconnectEffects = hasAttachedOnce
    console.warn("[terminal][connect] start", {
      sessionId,
      recoveryMode,
      attached,
      connecting,
      hasAttachedOnce,
      instanceId,
      skipInitialReconnectEffects: options?.skipInitialReconnectEffects ?? false,
      shouldApplyReconnectEffects,
      agentProvider: options?.agentProvider ?? null,
    })
    let recoveryState = null as Awaited<ReturnType<typeof loadSessionRecoveryState>>
    let shouldSpawnRecoverySession = false
    let appliedRecoveryState = false

    try {
      const shouldHydrateFromSnapshot = true
      await invoke("attach_session_with_snapshot", { sessionId })
      if (paused || generation !== connectionGeneration) {
        await invoke("detach_session", { sessionId }).catch((error) => {
          console.debug("[terminal][connect] detach after stale attach failed:", { sessionId, error })
        })
        return
      }
      console.warn("[terminal][connect] attach:ok", {
        sessionId,
        instanceId,
        shouldApplyReconnectEffects,
      })
      // AttachSnapshot succeeded — session was alive in daemon.
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
          await resizeLiveSession(
            cols,
            rows,
            shouldHydrateFromSnapshot && shouldForceDoubleResizeOnReconnect(options),
          )
        }
      }
      attached = true
      hasAttachedOnce = true
      sessionExited = false
      return
    } catch (e) {
      const msg = getAppErrorMessage(e)
      console.warn("[terminal][connect] attach:error", {
        sessionId,
        instanceId,
        recoveryMode,
        error: msg,
      })
      if (recoveryMode === "attach-only") {
        if (
          shouldRestoreRecoveryState(spawnOptions, options) &&
          (isMissingDaemonSessionFailure(e) || shouldRespawnAfterAttachFailure(
            e,
            hasAttachedOnce,
            false,
            spawnOptions,
            options,
          ))
        ) {
          await ensureFitted()
          if (!getLiveTerminal()) return
          const recoveryFetchResult = await fetchDaemonSnapshot()
          recoveryState = recoveryFetchResult.snapshot
          appliedRecoveryState = await applyRecoveryStateIfNeeded(
            recoveryState,
            true,
          )
        }
        let missingInitialTaskWorktreeExists = false
        if (!hasAttachedOnce && isMissingDaemonSessionFailure(e)) {
          missingInitialTaskWorktreeExists = await taskWorktreeExists()
        }

        const shouldRespawnMissingInitialTaskSession =
          !hasAttachedOnce &&
          isMissingDaemonSessionFailure(e) &&
          recoveryState == null &&
          hasObservedDaemonReady() &&
          missingInitialTaskWorktreeExists

        const shouldWaitForDaemonReadyBeforeInitialRespawn =
          !hasAttachedOnce &&
          isMissingDaemonSessionFailure(e) &&
          !hasObservedDaemonReady() &&
          missingInitialTaskWorktreeExists

        if (shouldWaitForDaemonReadyBeforeInitialRespawn) {
          console.warn("[terminal][connect] missing_initial_session:waiting_for_daemon_ready", {
            sessionId,
            instanceId,
          })
          return
        }

        if (shouldRespawnMissingInitialTaskSession) {
          console.warn("[terminal][connect] missing_initial_session:respawn", {
            sessionId,
            instanceId,
          })
          toast.warning(i18n.global.t("toasts.sessionRespawned"))
          shouldSpawnRecoverySession = true
        } else if (!hasAttachedOnce && isMissingDaemonSessionFailure(e)) {
          terminal.value?.write(formatMissingInitialTaskSessionMessage())
        }
        if (hasAttachedOnce || !isMissingDaemonSessionFailure(e)) {
          terminal.value?.write(formatAttachFailureMessage(msg))
        }
        if (shouldRespawnAfterAttachFailure(
          e,
          hasAttachedOnce,
          recoveryState != null,
          spawnOptions,
          options,
        )) {
          console.warn("[terminal][connect] pty_lost:respawn", {
            sessionId,
            error: msg,
            hasAttachedOnce,
            hasRecoveryState: recoveryState != null,
          })
          toast.warning(i18n.global.t(getRespawnToastKey(e, recoveryState != null)))
          shouldSpawnRecoverySession = true
        } else if (!shouldSpawnRecoverySession) {
          return
        }
      } else {
        shouldSpawnRecoverySession = true
      }
      // No existing session — spawn a new one if we have spawn options
      if (shouldSpawnRecoverySession && spawnOptions && getLiveTerminal()) {
        if (appliedRecoveryState) {
          preserveRecoveredScrollbackForNextSnapshot = true
        }
        await ensureFitted()
        const spawnTerminal = getLiveTerminal()
        if (!spawnTerminal) return
        const { cols, rows } = spawnTerminal
        try {
          await spawnOptions.spawnFn(sessionId, spawnOptions.cwd, spawnOptions.prompt, cols, rows)
        } catch (e) {
          preserveRecoveredScrollbackForNextSnapshot = false
          const msg = e instanceof Error ? e.message : String(e)
          console.error("[terminal] PTY spawn failed:", e)
          spawnTerminal.write(`\r\n\x1b[31mFailed to start agent: ${msg}\x1b[0m\r\n`)
          return
        }
        await invoke("attach_session_with_snapshot", { sessionId })
        if (paused || generation !== connectionGeneration) {
          await invoke("detach_session", { sessionId }).catch((error) => {
            console.debug("[terminal][connect] detach after stale recovery attach failed:", { sessionId, error })
          })
          return
        }
        attached = true
        hasAttachedOnce = true
        sessionExited = false
        const attachedTerminal = getLiveTerminal()
        if (attachedTerminal && shouldPushKittyKeyboardOnFreshAttach(options)) {
          attachedTerminal.write("\x1b[>1u")
        }
      }
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

  async function startListening() {
    paused = false
    connectionGeneration += 1
    const listeningGeneration = connectionGeneration
    const teardownId = `td-${sessionId}`
    console.warn("[terminal][instance] startListening", {
      sessionId,
      teardownId,
      instanceId,
      hasOutputListener: unlistenOutput != null,
      hasExitListener: unlistenExit != null,
      hasDaemonReadyListener: unlistenDaemonReady != null,
      hasStreamLostListener: unlistenStreamLost != null,
      attached,
      connecting,
      hasAttachedOnce,
    })

    if (!unlistenOutput) {
      let outputChunkCount = 0
      const outputUnlisten = await subscribeTerminalOutput([sessionId, teardownId], (payload) => {
        const sid = payload.session_id
        if (!sid || !terminal.value) return
        outputChunkCount += 1
        if (sid === sessionId) {
          markTaskSwitchFirstOutput(sessionId)
        }

        if (payload.data_b64) {
          const binary = atob(payload.data_b64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          handleTerminalOutputControlSequences(bytes)
          if (outputChunkCount <= 5) {
            console.warn("[terminal][output] chunk", {
              sessionId,
              instanceId,
              chunk: outputChunkCount,
              byteLength: bytes.length,
            })
          }
          terminal.value.write(bytes)
        } else if (isByteArray(payload.data)) {
          const bytes = new Uint8Array(payload.data)
          handleTerminalOutputControlSequences(bytes)
          if (outputChunkCount <= 5) {
            console.warn("[terminal][output] chunk", {
              sessionId,
              instanceId,
              chunk: outputChunkCount,
              byteLength: payload.data.length,
            })
          }
          terminal.value.write(bytes)
        }
      })
      if (!acceptRegisteredListener(listeningGeneration, "terminal_output", outputUnlisten)) return
      unlistenOutput = outputUnlisten
    }

    if (!unlistenSnapshot) {
      const snapshotUnlisten = await listen("terminal_snapshot", (event) => {
        const payload = event.payload as TerminalSnapshotEventPayload | undefined
        const sid = payload?.session_id
        if (!payload?.snapshot) return
        if ((sid === sessionId || sid === teardownId) && terminal.value) {
          const preserveRecoveredScrollback =
            sid === sessionId && preserveRecoveredScrollbackForNextSnapshot
          preserveRecoveredScrollbackForNextSnapshot = false
          if (!preserveRecoveredScrollback) {
            terminal.value.reset()
          }
          restoreTerminalModesFromSnapshot(payload.snapshot.vt)
          terminal.value.write(payload.snapshot.vt)
        }
      })
      if (!acceptRegisteredListener(listeningGeneration, "terminal_snapshot", snapshotUnlisten)) return
      unlistenSnapshot = snapshotUnlisten
    }

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

    if (!isCurrentListeningGeneration(listeningGeneration)) return
    await connectSession()
  }

  function pause() {
    paused = true
    connectionGeneration += 1
    void flushQueuedInput()
    const shouldDetach = attached || connecting || hasAttachedOnce
    attached = false
    connecting = false
    if (shouldDetach) {
      invoke("detach_session", { sessionId }).catch((error) => {
        console.warn("[terminal] Failed to detach session during pause:", error)
      })
    }
    if (unlistenOutput) {
      unlistenOutput()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "terminal_output",
      })
      unlistenOutput = null
    }
    if (unlistenSnapshot) {
      unlistenSnapshot()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "terminal_snapshot",
      })
      unlistenSnapshot = null
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
      hasOutputListener: unlistenOutput != null,
      hasSnapshotListener: unlistenSnapshot != null,
      hasExitListener: unlistenExit != null,
      hasDaemonReadyListener: unlistenDaemonReady != null,
      hasStreamLostListener: unlistenStreamLost != null,
    })
    void flushQueuedInput()
    if (attached || connecting || hasAttachedOnce) {
      invoke("detach_session", { sessionId }).catch((error) => {
        console.warn("[terminal] Failed to detach session during dispose:", error)
      })
    }
    disposed = true
    attached = false
    fileExistsCache.clear()
    if (fitRafId) cancelAnimationFrame(fitRafId)
    if (pendingInputFlushTimer) {
      clearTimeout(pendingInputFlushTimer)
      pendingInputFlushTimer = null
    }
    cleanupContainerEvents?.()
    cleanupContainerEvents = null
    cleanupNativeDropEvents?.()
    cleanupNativeDropEvents = null
    stopThemeWatch?.()
    stopThemeWatch = null
    unregisterE2ETerminalBuffer?.()
    unregisterE2ETerminalBuffer = null
    clearPendingClipboardImage()
    pendingClipboardImageLoad = null
    kittyClipboardBuffer = ""
    bracketedPasteMode = false
    hasObservedBracketedPasteMode = false
    lastNativeDropSignature = null
    lastNativeDropAt = 0
    if (unlistenOutput) {
      unlistenOutput()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "terminal_output",
      })
    }
    if (unlistenSnapshot) {
      unlistenSnapshot()
      console.warn("[terminal][instance] listener:remove", {
        sessionId,
        instanceId,
        event: "terminal_snapshot",
      })
    }
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
    terminal.value?.dispose()
    terminal.value = null
    unlistenOutput = null
    unlistenSnapshot = null
    unlistenExit = null
    unlistenDaemonReady = null
    unlistenStreamLost = null
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
    // Try resize — if it fails, the session is dead → re-run startListening
    try {
      const { cols, rows } = terminal.value
      await invoke("resize_session", { sessionId, cols, rows })
    } catch (error) {
      console.debug("[terminal] resize probe failed; respawning session:", { sessionId, error })
      // Session dead — re-spawn
      await startListening()
      return
    }
    // Session alive — just send SIGWINCH
    const { cols, rows } = terminal.value
    await invoke("resize_session", { sessionId, cols: cols - 1, rows }).catch((error) => {
      console.debug("[terminal] reconnect nudge shrink resize failed:", { sessionId, error })
    })
    await invoke("resize_session", { sessionId, cols, rows }).catch((error) => {
      console.debug("[terminal] reconnect nudge restore resize failed:", { sessionId, error })
    })
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
      await invoke("resize_session", { sessionId, cols, rows })
    } catch (error) {
      console.debug("[terminal] ensureConnected attach probe failed; reconnecting:", { sessionId, error })
      attached = false
      await startListening()
    }
  }

  return { terminal, init, startListening, fit, fitDeferred, redraw, ensureConnected, pause, dispose }
}
