import { ref, onUnmounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { invoke } from "../invoke"
import { listen } from "../listen"

export function useTerminal(sessionId: string) {
  const terminal = ref<Terminal | null>(null)
  const fitAddon = new FitAddon()
  let unlistenOutput: (() => void) | null = null
  let unlistenExit: (() => void) | null = null
  let logged = false

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
    fitAddon.fit()

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
    // Listen for terminal output from daemon
    unlistenOutput = await listen<{ session_id: string; data: number[] }>(
      "terminal_output",
      (event) => {
        if (event.payload.session_id === sessionId && terminal.value) {
          const data = event.payload.data
          // Debug: log first chunk to verify data format
          if (data && !logged) {
            console.log("[terminal] data type:", typeof data, "isArray:", Array.isArray(data), "len:", data?.length, "first5:", data?.slice?.(0, 5))
            logged = true
          }
          if (Array.isArray(data)) {
            terminal.value.write(new Uint8Array(data))
          } else if (typeof data === "string") {
            terminal.value.write(data)
          }
        }
      }
    )

    // Listen for session exit
    unlistenExit = await listen<{ session_id: string; code: number }>(
      "session_exit",
      (event) => {
        if (event.payload.session_id === sessionId && terminal.value) {
          terminal.value.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
        }
      }
    )

    // Attach to daemon session to start receiving output
    await invoke("attach_session", { sessionId })

    // Sync xterm.js size to the PTY — the spawn may have used different dimensions
    if (terminal.value) {
      const { cols, rows } = terminal.value;
      invoke("resize_session", { sessionId, cols, rows }).catch(() => {})
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
