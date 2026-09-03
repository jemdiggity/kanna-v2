<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  error: string | null;
  noDiff: boolean;
  loading: boolean;
}>();

defineEmits<{
  (e: "scroll"): void;
}>();

const containerRef = ref<HTMLElement | null>(null);

function getContainerElement(): HTMLElement | null {
  return containerRef.value;
}

defineExpose({ getContainerElement });
</script>

<template>
  <div v-if="error" class="diff-status diff-error" role="alert" data-testid="diff-unavailable">{{ error }}</div>
  <div v-else-if="noDiff && !loading" class="diff-status">{{ $t('diffView.noChanges') }}</div>
  <div ref="containerRef" class="diff-container" @scroll="$emit('scroll')"></div>
</template>

<style scoped>
.diff-status {
  padding: 24px;
  color: var(--kn-text-muted);
  text-align: center;
  font-size: 13px;
}

.diff-error {
  color: var(--kn-danger);
}

.diff-container {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding-inline-end: 12px;
  overflow: auto;
}

.diff-container :deep(.diff-file) {
  position: relative;
  margin-bottom: 2px;
}

.diff-container :deep(.diff-file-header) {
  position: sticky;
  top: -1px;
  z-index: 2;
  padding: 7px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-panel);
  color: var(--kn-text-primary);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.diff-container :deep(.diff-file-header.diff-search-match) {
  background: rgba(255, 196, 61, 0.22);
  box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.3);
}

.diff-container :deep(.diff-file-header.diff-search-active) {
  background: rgba(255, 196, 61, 0.4);
  box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.85);
}

.diff-container :deep(.diff-file-skipped) {
  padding: 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  color: var(--kn-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.diff-container :deep(diffs-container) {
  color-scheme: light dark;
}
</style>
