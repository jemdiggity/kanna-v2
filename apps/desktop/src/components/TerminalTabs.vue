<script setup lang="ts">
import { ref } from "vue";
import AgentView from "./AgentView.vue";

defineProps<{
  sessionId: string | null;
}>();

const activeTab = ref<"agent" | "shell">("agent");
</script>

<template>
  <div class="terminal-tabs">
    <div class="tab-bar">
      <button
        class="tab"
        :class="{ active: activeTab === 'agent' }"
        @click="activeTab = 'agent'"
      >
        Agent
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'shell' }"
        @click="activeTab = 'shell'"
      >
        Shell
      </button>
    </div>
    <div class="tab-content">
      <AgentView
        v-if="activeTab === 'agent' && sessionId"
        :session-id="sessionId"
      />
      <div v-else-if="activeTab === 'agent' && !sessionId" class="placeholder">
        No agent session active
      </div>
      <div v-else-if="activeTab === 'shell'" class="placeholder">
        Shell terminal (xterm.js -- coming soon)
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #333;
  background: #1e1e1e;
  padding: 0 12px;
}

.tab {
  padding: 6px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #888;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s;
}

.tab:hover {
  color: #ccc;
}

.tab.active {
  color: #e0e0e0;
  border-bottom-color: #0066cc;
}

.tab-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 13px;
}
</style>
