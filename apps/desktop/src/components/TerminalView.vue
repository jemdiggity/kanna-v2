<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"
import { useTerminal } from "../composables/useTerminal"
import "@xterm/xterm/css/xterm.css"

const props = defineProps<{ sessionId: string }>()
const containerRef = ref<HTMLElement | null>(null)
const { init, startListening, fit, dispose } = useTerminal(props.sessionId)

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
  background: #1a1a1a;
}
</style>
