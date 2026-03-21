<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"
import { useTerminal, type SpawnOptions } from "../composables/useTerminal"
import "@xterm/xterm/css/xterm.css"

const props = defineProps<{
  sessionId: string
  spawnOptions?: SpawnOptions
}>()

const containerRef = ref<HTMLElement | null>(null)
const { terminal, init, startListening, fit, redraw, dispose } = useTerminal(props.sessionId, props.spawnOptions)

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
    resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  dispose()
})
</script>

<template>
  <div ref="containerRef" class="terminal-container"></div>
</template>

<style scoped>
.terminal-container {
  flex: 1;
  overflow: hidden;
  background: #1e1e1e;
}
</style>
