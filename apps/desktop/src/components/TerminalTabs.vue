<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "../invoke";
import AgentView from "./AgentView.vue";
import TerminalView from "./TerminalView.vue";
import DiffView from "./DiffView.vue";

const props = defineProps<{
  sessionId: string | null;
  agentType?: string;
  worktreePath?: string;
  repoPath?: string;
  prompt?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
}>();

const diffViewRef = ref<InstanceType<typeof DiffView> | null>(null);

interface ShellTab {
  id: string;
  label: string;
}

const emit = defineEmits<{
  (e: "agent-completed"): void;
}>();

const activeTab = ref<"agent" | "diff" | string>("agent");
const shellTabs = ref<ShellTab[]>([]);

async function addShellTab() {
  const sessionId = crypto.randomUUID();
  const cwd = props.worktreePath ?? (window as any).__TAURI_INTERNALS__?.metadata?.currentDir ?? "/tmp";

  try {
    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login"],
      env: {},
      cols: 80,
      rows: 24,
    });
  } catch (e) {
    console.error("Failed to spawn shell session:", e);
    return;
  }

  const label = `Shell ${shellTabs.value.length + 1}`;
  shellTabs.value.push({ id: sessionId, label });
  activeTab.value = sessionId;
}
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
        :class="{ active: activeTab === 'diff' }"
        @click="activeTab = 'diff'; diffViewRef?.refresh()"
      >
        Diff
      </button>
      <button
        v-for="tab in shellTabs"
        :key="tab.id"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
      <button class="tab tab-add" @click="addShellTab" title="New shell">+</button>
    </div>
    <div class="tab-content">
      <!-- PTY mode: key by sessionId so switching tasks creates a new terminal -->
      <TerminalView
        v-if="sessionId && agentType === 'pty'"
        v-show="activeTab === 'agent'"
        :key="sessionId"
        :session-id="sessionId"
        :spawn-options="spawnPtySession && worktreePath && prompt ? {
          cwd: worktreePath,
          prompt: prompt,
          spawnFn: spawnPtySession,
        } : undefined"
      />
      <!-- SDK mode: key by sessionId so switching tasks creates a new view -->
      <AgentView
        v-if="sessionId && agentType !== 'pty'"
        v-show="activeTab === 'agent'"
        :key="sessionId"
        :session-id="sessionId"
        @completed="emit('agent-completed')"
      />
      <div v-if="!sessionId" v-show="activeTab === 'agent'" class="placeholder">
        No agent session active
      </div>
      <!-- Diff tab -->
      <DiffView
        v-if="repoPath"
        v-show="activeTab === 'diff'"
        ref="diffViewRef"
        :repo-path="repoPath"
        :worktree-path="worktreePath"
      />
      <div v-if="!repoPath" v-show="activeTab === 'diff'" class="placeholder">
        No repository selected
      </div>
      <!-- Shell tabs -->
      <template v-for="tab in shellTabs" :key="tab.id">
        <TerminalView
          v-show="activeTab === tab.id"
          :session-id="tab.id"
        />
      </template>
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

.tab-add {
  margin-left: 4px;
  padding: 6px 10px;
  font-size: 16px;
  line-height: 1;
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
