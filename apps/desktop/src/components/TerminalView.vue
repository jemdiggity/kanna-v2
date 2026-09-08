<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated, watch } from "vue"
import { useTerminal, type SpawnOptions } from "../composables/useTerminal"
import { useTerminalFocusWhenActive } from "../composables/useTerminalFocusWhenActive"
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
  dispose()
})
</script>

<template>
  <div class="terminal-wrapper">
    <div ref="containerRef" class="terminal-container"></div>
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
</style>
