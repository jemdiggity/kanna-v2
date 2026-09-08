<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated, watch, nextTick } from "vue"
import { useTerminal, type SpawnOptions } from "../composables/useTerminal"
import { useTerminalFocusWhenActive } from "../composables/useTerminalFocusWhenActive"
import { useAltScreenHistory } from "../composables/terminalAltScreenHistory"
import { shouldDelayConnectUntilAfterInitialLayout } from "../composables/terminalSessionRecovery"
import { nextFrameOrTimeout } from "../utils/animationFrame"
import { shouldStartTerminalSession } from "../composables/terminalVisibility"
import { markTaskSwitchMounted, markTaskSwitchReady } from "../perf/taskSwitchPerf"
import "@xterm/xterm/css/xterm.css"

const props = defineProps<{
  sessionId: string
  spawnOptions?: SpawnOptions
  active?: boolean
  kittyKeyboard?: boolean
  agentProvider?: string
  worktreePath?: string
  agentTerminal?: boolean
  recoverSession?: (sessionId: string, options?: { cols?: number; rows?: number }) => Promise<void>
}>()

const containerRef = ref<HTMLElement | null>(null)
const {
  terminal,
  init,
  startListening,
  fit,
  fitDeferred,
  redraw,
  ensureConnected,
  pause,
  dispose,
} = useTerminal(props.sessionId, props.spawnOptions, {
  kittyKeyboard: props.kittyKeyboard,
  agentProvider: props.agentProvider,
  worktreePath: props.worktreePath,
  agentTerminal: props.agentTerminal,
  recoverSession: props.recoverSession,
})

defineExpose({
  focus: () => terminal.value?.focus(),
  fit,
  redraw,
  ensureConnected,
})

// A full-screen TUI on the alternate screen hides the normal buffer — setup
// output and prior-stage history — and xterm cannot scroll past it. Offer that
// hidden text read-only while the TUI holds the screen.
const {
  altScreenActive,
  hasHiddenHistory,
  readHistoryLines,
  dispose: disposeAltScreenHistory,
} = useAltScreenHistory(terminal)
const historyOverlayOpen = ref(false)
const historyText = ref("")
const historyBodyRef = ref<HTMLElement | null>(null)

async function openHistoryOverlay() {
  historyText.value = readHistoryLines().join("\n")
  historyOverlayOpen.value = true
  await nextTick()
  const body = historyBodyRef.value
  if (body) {
    body.scrollTop = body.scrollHeight
    body.focus()
  }
}

function closeHistoryOverlay() {
  if (!historyOverlayOpen.value) return
  historyOverlayOpen.value = false
  if (props.active !== false) {
    // Refocus after the overlay leaves the DOM: WebKit's post-click focus
    // handling for the removed Close button otherwise lands focus on <body>,
    // undoing a synchronous terminal.focus().
    void nextTick().then(() => {
      if (!historyOverlayOpen.value) terminal.value?.focus()
    })
  }
}

// When the TUI leaves the alternate screen the buffer is scrollable again.
watch(altScreenActive, (active) => {
  if (!active) closeHistoryOverlay()
})

let resizeObserver: ResizeObserver | null = null
let started = false
const {
  cancelPendingFocus,
  focusWhenActive,
} = useTerminalFocusWhenActive({
  isActive: () => props.active === true,
  getTerminal: () => terminal.value,
})

async function startWhenActive() {
  if (!shouldStartTerminalSession(props.active) || started || !containerRef.value) return
  started = true
  if (shouldDelayConnectUntilAfterInitialLayout(props.spawnOptions, {
    agentProvider: props.agentProvider,
    worktreePath: props.worktreePath,
  })) {
    await waitForStableLayout(containerRef.value)
  }
  await startListening()
}

async function waitForStableLayout(el: HTMLElement) {
  let last = { width: 0, height: 0 }
  for (let i = 0; i < 10; i++) {
    await nextFrameOrTimeout()
    const current = { width: el.offsetWidth, height: el.offsetHeight }
    if (
      current.width > 0 &&
      current.height > 0 &&
      current.width === last.width &&
      current.height === last.height
    ) {
      return
    }
    last = current
  }
}

onMounted(async () => {
  if (containerRef.value) {
    init(containerRef.value)
    resizeObserver = new ResizeObserver(() => fitDeferred())
    resizeObserver.observe(containerRef.value)
    if (props.agentTerminal && props.active !== false) {
      markTaskSwitchMounted(props.sessionId)
    }
    await startWhenActive()
    if (props.agentTerminal && props.active !== false) {
      markTaskSwitchReady(props.sessionId, "cold")
    }
    await focusWhenActive()
  }
})

onActivated(async () => {
  if (props.agentTerminal && props.active !== false) {
    markTaskSwitchMounted(props.sessionId)
    markTaskSwitchReady(props.sessionId, "warm")
  }
  await startWhenActive()
  fitDeferred()
  await focusWhenActive()
})

onDeactivated(() => {
  cancelPendingFocus()
  pause()
  started = false
})

watch(
  () => props.active,
  async (active) => {
    if (active && props.agentTerminal) {
      markTaskSwitchMounted(props.sessionId)
      markTaskSwitchReady(props.sessionId, "warm")
    }
    await startWhenActive()
    if (active) {
      await focusWhenActive()
    }
  },
)

onUnmounted(() => {
  cancelPendingFocus()
  resizeObserver?.disconnect()
  disposeAltScreenHistory()
  dispose()
})
</script>

<template>
  <div class="terminal-wrapper">
    <div ref="containerRef" class="terminal-container"></div>
    <div v-if="!historyOverlayOpen" class="terminal-tools">
      <button
        v-if="hasHiddenHistory"
        class="terminal-tool-chip"
        title="The full-screen agent is hiding earlier terminal output (setup scripts, previous stages). Click to view it."
        @click="openHistoryOverlay"
      >
        Earlier output
      </button>
    </div>
    <div v-if="historyOverlayOpen" class="terminal-history-overlay">
      <div class="terminal-history-header">
        <span>Earlier output — setup &amp; previous stages</span>
        <button class="terminal-history-close" @click="closeHistoryOverlay">Close</button>
      </div>
      <pre
        ref="historyBodyRef"
        class="terminal-history-body"
        tabindex="-1"
        @keydown.esc.stop.prevent="closeHistoryOverlay"
      >{{ historyText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.terminal-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--kn-terminal-bg);
  padding: 8px 12px;
}
.terminal-container {
  width: 100%;
  height: 100%;
}
.terminal-tools {
  position: absolute;
  top: 6px;
  right: 18px;
  z-index: 5;
  display: flex;
  gap: 6px;
}
.terminal-tool-chip {
  padding: 2px 8px;
  font-size: 11px;
  color: var(--kn-text-muted);
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-default);
  border-radius: 10px;
  opacity: 0.75;
  cursor: pointer;
}
.terminal-tool-chip:hover {
  opacity: 1;
  color: var(--kn-text-primary);
  border-color: var(--kn-border-strong);
}
.terminal-history-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  background: var(--kn-terminal-bg);
}
.terminal-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--kn-text-muted);
  border-bottom: 1px solid var(--kn-border-default);
}
.terminal-history-close {
  padding: 2px 8px;
  font-size: 11px;
  color: var(--kn-text-muted);
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-default);
  border-radius: 10px;
  cursor: pointer;
}
.terminal-history-close:hover {
  color: var(--kn-text-primary);
  border-color: var(--kn-border-strong);
}
.terminal-history-body {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.4;
  color: var(--kn-text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  outline: none;
}
</style>
