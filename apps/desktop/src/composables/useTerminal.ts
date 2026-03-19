import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { invoke } from "../invoke"
import { listen } from "../listen"

export interface SpawnOptions {
  cwd: string
  prompt: string
  spawnFn: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>
}

export function useTerminal(sessionId: string, spawnOptions?: SpawnOptions) {
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
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
    term.open(container)

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }

    // Let app-level shortcuts pass through even when terminal has focus
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === "Escape") return false
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && (e.key === "N" || e.key === "n")) return false
      if (meta && e.key === "/") return false
      if (meta && e.key === "p") return false
      if (meta && e.key === "s") return false
      if (meta && e.key === "m") return false
      if (meta && e.key === "d") return false
      if (meta && e.key === "j") return false
      if (meta && !e.shiftKey && e.key === "n") return false
      if (meta && e.shiftKey && (e.key === "Z" || e.key === "z")) return false
      if (meta && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return false
      if (meta && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) return false
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
      // Send resize to trigger SIGWINCH → Claude redraws its TUI.
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
    if (unlistenOutput) unlistenOutput()
    if (unlistenExit) unlistenExit()
    terminal.value?.dispose()
  }

  onUnmounted(() => {
    dispose()
  })

  return { terminal, init, startListening, fit, dispose }
}
