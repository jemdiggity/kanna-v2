import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { SerializeAddon } from "@xterm/addon-serialize"
import { invoke } from "../invoke"
import { listen } from "../listen"

// Module-level cache: sessionId → serialized ANSI scrollback
const scrollbackCache = new Map<string, string>()

export interface SpawnOptions {
  cwd: string
  prompt: string
  spawnFn: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions) {
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  const serializeAddon = new SerializeAddon()
  let unlistenOutput: (() => void) | null = null
  let unlistenExit: (() => void) | null = null

  function init(container: HTMLElement) {
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 13,
      theme: { background: "#1a1a1a", foreground: "#e0e0e0", cursor: "#e0e0e0" },
      scrollback: 10000,
      cursorBlink: true,
    })
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(serializeAddon)
    term.open(container)

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }

    // Restore cached scrollback for tab switches (same app session).
    // Will be cleared if we reattach to a live daemon session.
    const cached = scrollbackCache.get(sessionId)
    if (cached) {
      term.write(cached)
    }

    // Let app-level shortcuts pass through even when terminal has focus
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      // Shift+Cmd+N (new task), Cmd+/ (shortcuts), Cmd+P (file picker),
      // Cmd+S (make PR), Cmd+M (merge), Cmd+N (new window)
      if (meta && e.shiftKey && e.key === "N") return false
      if (meta && e.key === "/") return false
      if (meta && e.key === "p") return false
      if (meta && e.key === "s") return false
      if (meta && e.key === "m") return false
      if (meta && !e.shiftKey && e.key === "n") return false
      if (meta && e.shiftKey && e.key === "Z") return false
      // Cmd+Opt+Left/Right for tab navigation
      if (meta && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return false
      // Cmd+Opt+Up/Down for task navigation
      if (meta && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) return false
      return true // let terminal handle everything else
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
    unlistenOutput = await listen<{ session_id: string; data_b64?: string; data?: number[] }>(
      "terminal_output",
      (event) => {
        if (event.payload.session_id === sessionId && terminal.value) {
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

    unlistenExit = await listen<{ session_id: string; code: number }>(
      "session_exit",
      (event) => {
        if (event.payload.session_id === sessionId && terminal.value) {
          terminal.value.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
        }
      }
    )

    // Try to attach first — session may already exist in daemon (e.g. after app restart)
    try {
      await invoke("attach_session", { sessionId })
      // Attach succeeded — session was alive in daemon.
      // Daemon replays scrollback buffer, so clear local cache to avoid double-render.
      scrollbackCache.delete(sessionId)
      if (terminal.value) {
        terminal.value.reset()
        const { cols, rows } = terminal.value
        invoke("resize_session", { sessionId, cols, rows }).catch(() => {})
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
    // Save scrollback before disposing
    if (terminal.value) {
      try {
        const serialized = serializeAddon.serialize()
        if (serialized) {
          scrollbackCache.set(sessionId, serialized)
        }
      } catch {
        // Serialize may fail if terminal is already disposed
      }
    }

    if (unlistenOutput) unlistenOutput()
    if (unlistenExit) unlistenExit()
    terminal.value?.dispose()
  }

  onUnmounted(() => {
    dispose()
  })

  return { terminal, init, startListening, fit, dispose }
}
