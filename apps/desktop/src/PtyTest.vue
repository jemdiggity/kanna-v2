<script setup lang="ts">
import { ref, onMounted } from "vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import "@xterm/xterm/css/xterm.css"

const containerRef = ref<HTMLElement | null>(null)
const status = ref("Starting...")

onMounted(async () => {
  if (!containerRef.value) return

  // 1. Create xterm.js terminal
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: 13,
    theme: { background: "#1a1a1a", foreground: "#e0e0e0" },
    scrollback: 10000,
    cursorBlink: true,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(containerRef.value)
  fitAddon.fit()
  window.addEventListener("resize", () => fitAddon.fit())

  const sessionId = crypto.randomUUID()
  status.value = `Session: ${sessionId}`

  // 2. Listen for terminal output BEFORE spawning
  await listen<any>("terminal_output", (event) => {
    const p = event.payload
    if (p.session_id !== sessionId) return

    if (p.data_b64) {
      const binary = atob(p.data_b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      term.write(bytes)
    } else if (Array.isArray(p.data)) {
      term.write(new Uint8Array(p.data))
    } else {
      console.warn("[pty-test] unknown payload format:", Object.keys(p))
    }
  })

  await listen<any>("session_exit", (event) => {
    if (event.payload.session_id === sessionId) {
      term.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`)
      status.value = `Exited (code ${event.payload.code})`
    }
  })

  // 3. Send keystrokes to daemon
  term.onData((data) => {
    invoke("send_input", {
      sessionId,
      data: Array.from(new TextEncoder().encode(data)),
    }).catch(() => {})
  })

  term.onResize(({ cols, rows }) => {
    invoke("resize_session", { sessionId, cols, rows }).catch(() => {})
  })

  // 4. Spawn Claude in PTY
  status.value = "Spawning..."
  try {
    await invoke("spawn_session", {
      sessionId,
      cwd: "/tmp",
      executable: "/bin/zsh",
      args: ["--login", "-c", "claude --dangerously-skip-permissions 'say hello world briefly'"],
      env: { TERM: "xterm-256color" },
      cols: term.cols,
      rows: term.rows,
    })
    status.value = "Spawned. Attaching..."
  } catch (e: any) {
    status.value = `Spawn failed: ${e}`
    term.write(`\r\nSpawn error: ${e}\r\n`)
    return
  }

  // 5. Attach — this creates a dedicated connection for output streaming
  try {
    await invoke("attach_session", { sessionId })
    status.value = "Attached — waiting for output..."
  } catch (e: any) {
    status.value = `Attach failed: ${e}`
    term.write(`\r\nAttach error: ${e}\r\n`)
  }
})
</script>

<template>
  <div style="display: flex; flex-direction: column; height: 100vh; background: #1a1a1a;">
    <div style="padding: 6px 12px; background: #252525; color: #888; font-size: 12px; font-family: monospace;">
      PTY Test — {{ status }}
    </div>
    <div ref="containerRef" style="flex: 1; overflow: hidden;"></div>
  </div>
</template>
