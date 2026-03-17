<script setup lang="ts">
import type { PipelineItem } from "@kanna/db";
import TaskHeader from "./TaskHeader.vue";
import TerminalTabs from "./TerminalTabs.vue";
import ActionBar from "./ActionBar.vue";

defineProps<{
  item: PipelineItem | null;
}>();

const emit = defineEmits<{
  (e: "make-pr"): void;
  (e: "merge"): void;
  (e: "close-task"): void;
}>();
</script>

<template>
  <main class="main-panel">
    <template v-if="item">
      <TaskHeader :item="item" />
      <TerminalTabs :session-id="null" />
      <ActionBar
        :item="item"
        @make-pr="emit('make-pr')"
        @merge="emit('merge')"
        @close-task="emit('close-task')"
      />
    </template>
    <div v-else class="empty-state">
      <p class="empty-title">No task selected</p>
      <p class="empty-hint">Select a task from the sidebar or press Cmd+N to create one.</p>
    </div>
  </main>
</template>

<style scoped>
.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #1a1a1a;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: #888;
}

.empty-hint {
  font-size: 12px;
  color: #555;
}
</style>
