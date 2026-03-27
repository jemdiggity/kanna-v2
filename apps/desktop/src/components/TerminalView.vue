<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"
import { useTerminal, type SpawnOptions } from "../composables/useTerminal"
import "@xterm/xterm/css/xterm.css"

const props = defineProps<{
  sessionId: string
  spawnOptions?: SpawnOptions
  kittyKeyboard?: boolean
  agentProvider?: string
}>()

const containerRef = ref<HTMLElement | null>(null)
const { terminal, init, startListening, fit, fitDeferred, redraw, dispose } = useTerminal(props.sessionId, props.spawnOptions, { kittyKeyboard: props.kittyKeyboard, agentProvider: props.agentProvider })

defineExpose({
  focus: () => terminal.value?.focus(),
  fit,
  redraw,
})

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (containerRef.value) {
    init(containerRef.value)
    startListening()
    resizeObserver = new ResizeObserver(() => fitDeferred())
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
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
  flex: 1;
  overflow: hidden;
  background: #1e1e1e;
  padding: 8px 12px;
}
.terminal-container {
  width: 100%;
  height: 100%;
}
</style>
