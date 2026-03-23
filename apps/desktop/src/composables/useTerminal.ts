import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { ImageAddon } from "@xterm/addon-image"
import { WebglAddon } from "@xterm/addon-webgl"
import { openUrl } from "@tauri-apps/plugin-opener"
import { invoke } from "../invoke"
import { listen } from "../listen"
import { isTauri } from "../tauri-mock"
import { isAppShortcut } from "./useKeyboardShortcuts"

export interface SpawnOptions {
  cwd: string
  prompt: string
  spawnFn: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>
}

export interface TerminalOptions {
  kittyKeyboard?: boolean
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions, options?: TerminalOptions) {
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  let unlistenOutput: (() => void) | null = null
  let unlistenExit: (() => void) | null = null

  function handleLinkActivate(_event: MouseEvent, uri: string) {
    if (isTauri) {
      openUrl(uri).catch((e) => console.error("[terminal] Failed to open URL:", e))
    } else {
      window.open(uri, "_blank")
    }
  }

  function init(container: HTMLElement) {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1,
      linkHandler: { activate: handleLinkActivate },
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        selectionBackground: "#264f78",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      scrollback: 10000,
      cursorBlink: false,
      ...(options?.kittyKeyboard ? { vtExtensions: { kittyKeyboard: true } } : {}),
    })
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon(handleLinkActivate))
    try {
      term.loadAddon(new WebglAddon())
    } catch (e) {
      console.warn("[terminal] WebGL addon failed, falling back to DOM renderer:", e)
    }
    term.loadAddon(new ImageAddon())
    term.open(container)

    // Push kitty keyboard mode so Shift+Enter sends CSI 13;2 u instead of bare CR.
    // vtExtensions.kittyKeyboard enables protocol support; this push activates it.
    if (options?.kittyKeyboard) {
      term.write("\x1b[>1u")
    }

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }

    // Let app-level shortcuts pass through even when terminal has focus,
    // but always let Escape reach the terminal (needed for Claude CLI).
    // In kitty keyboard mode, Cmd+C/V would be encoded as CSI sequences
    // and sent to the PTY instead of triggering clipboard operations —
    // intercept Cmd+C here and let Cmd+V fall through to the native paste event.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // When a modal overlay is visible, let Escape bubble to the app to dismiss it
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
        return false
      }
      return true
    })

    // Send keystrokes to daemon
    term.onData((data) => {
      invoke("send_input", {
        sessionId,
        data: Array.from(new TextEncoder().encode(data)),
      })
    })

    // Handle resize
    term.onResize(({ cols, rows }) => {
      invoke("resize_session", { sessionId, cols, rows })
    })

    terminal.value = term
  }

  async function startListening() {
    const teardownId = `td-${sessionId}`

    unlistenOutput = await listen(
      "terminal_output",
      (event) => {
        const sid = event.payload.session_id
        if ((sid === sessionId || sid === teardownId) && terminal.value) {
          if (event.payload.data_b64) {
            const binary = atob(event.payload.data_b64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i)
            }
            terminal.value.write(bytes)
          } else if (Array.isArray(event.payload.data)) {
            terminal.value.write(new Uint8Array(event.payload.data))
          }
        }
      }
    )

    unlistenExit = await listen(
      "session_exit",
      (event) => {
        const sid = event.payload.session_id
        if ((sid === sessionId || sid === teardownId) && terminal.value) {
          terminal.value.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
        }
      }
    )

    // Try to attach first — session may already exist in daemon (e.g. after app restart)
    try {
      await invoke("attach_session", { sessionId })
      // Attach succeeded — session was alive in daemon.
      // Clear display and force SIGWINCH so Claude TUI redraws from scratch.
      // Use CSI 2 J + CSI H instead of reset() to preserve internal state
      // (kitty keyboard mode, character attributes, etc.).
      if (terminal.value) {
        terminal.value.write("\x1b[?25l\x1b[2J\x1b[H") // hide cursor, clear display, cursor home
        const { cols, rows } = terminal.value
        // Force a size change then restore — guarantees SIGWINCH fires
        await invoke("resize_session", { sessionId, cols: cols - 1, rows }).catch(() => {})
        await invoke("resize_session", { sessionId, cols, rows }).catch(() => {})
      }
      return
    } catch {
      // Attach failed — session doesn't exist in daemon
    }

    // No existing session — spawn a new one if we have spawn options
    if (spawnOptions && terminal.value) {
      const { cols, rows } = terminal.value
      try {
        await spawnOptions.spawnFn(sessionId, spawnOptions.cwd, spawnOptions.prompt, cols, rows)
      } catch (e) {
        console.error("[terminal] PTY spawn failed:", e)
        return
      }
      // Now attach to the newly spawned session
      await invoke("attach_session", { sessionId })
    }
  }

  function fit() {
    fitAddon.fit()
  }

  function dispose() {
    if (unlistenOutput) unlistenOutput()
    if (unlistenExit) unlistenExit()
    terminal.value?.dispose()
  }

  onUnmounted(() => {
    dispose()
  })

  /** Re-fit the terminal and send SIGWINCH to force TUI apps to redraw.
   *  If the session is dead, re-attach or re-spawn. */
  async function redraw() {
    if (!terminal.value) return
    fitAddon.fit()
    // Try resize — if it fails, the session is dead → re-run startListening
    try {
      const { cols, rows } = terminal.value
      await invoke("resize_session", { sessionId, cols, rows })
    } catch {
      // Session dead — re-spawn
      await startListening()
      return
    }
    // Session alive — just send SIGWINCH
    const { cols, rows } = terminal.value
    await invoke("resize_session", { sessionId, cols: cols - 1, rows }).catch(() => {})
    await invoke("resize_session", { sessionId, cols, rows }).catch(() => {})
  }

  return { terminal, init, startListening, fit, redraw, dispose }
}
