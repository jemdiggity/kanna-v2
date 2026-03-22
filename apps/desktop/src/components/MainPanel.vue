<script setup lang="ts">
import type { PipelineItem } from "@kanna/db";
import { hasTag } from "@kanna/core";
import TaskHeader from "./TaskHeader.vue";
import TerminalTabs from "./TerminalTabs.vue";

defineProps<{
  item: PipelineItem | null;
  repoPath?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
  maximized?: boolean;
  blockers?: PipelineItem[];
  hasRepos?: boolean;
}>();

const emit = defineEmits<{
  (e: "agent-completed"): void;
}>();
</script>

<template>
  <main class="main-panel">
    <template v-if="item">
      <TaskHeader v-if="!maximized" :item="item" />
      <template v-if="hasTag(item, 'blocked')">
        <div class="blocked-placeholder">
          <p class="blocked-title">Task Blocked</p>
          <p class="blocked-hint">This task will start automatically when all blockers complete.</p>
          <div v-if="blockers && blockers.length > 0" class="blocked-by">
            <p class="blocked-by-label">Waiting on:</p>
            <div v-for="b in blockers" :key="b.id" class="blocker-item">
              <span
                class="blocker-status"
                :style="{ color: hasTag(b, 'done') ? '#666' : '#0066cc' }"
              >{{ hasTag(b, 'done') ? 'Done' : 'Active' }}</span>
              <span class="blocker-name">{{ b.display_name || (b.prompt ? b.prompt.slice(0, 60) : 'Untitled') }}</span>
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <TerminalTabs
          :session-id="item.id"
          :agent-type="item.agent_type || 'pty'"
          :repo-path="repoPath"
          :worktree-path="item.branch ? `${repoPath}/.kanna-worktrees/${item.branch}` : undefined"
          :prompt="item.prompt || ''"
          :spawn-pty-session="spawnPtySession"
          @agent-completed="emit('agent-completed')"
        />
      </template>
    </template>
    <div v-else class="empty-state">
      <template v-if="!hasRepos">
        <p class="empty-title">No repos imported</p>
        <p class="empty-hint">Press <kbd>⇧</kbd><kbd>⌘</kbd><kbd>I</kbd> to import a repo and get started.</p>
      </template>
      <template v-else>
        <p class="empty-title">No task selected</p>
        <p class="empty-hint">Select a task from the sidebar or press <kbd>⇧</kbd><kbd>⌘</kbd><kbd>N</kbd> to create one.</p>
      </template>
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

.empty-hint kbd {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: #999;
}

.empty-hint kbd + kbd {
  margin-left: 2px;
}

.blocked-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  max-width: 600px;
  margin: 0 auto;
}

.blocked-title {
  font-size: 18px;
  font-weight: 600;
  color: #888;
}

.blocked-prompt {
  font-size: 13px;
  color: #aaa;
  text-align: center;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.blocked-by {
  width: 100%;
  margin-top: 8px;
}

.blocked-by-label {
  font-size: 12px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.blocker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #252525;
  border-radius: 4px;
  margin-bottom: 4px;
}

.blocker-status {
  font-size: 11px;
  font-weight: 600;
  min-width: 80px;
}

.blocker-name {
  font-size: 12px;
  color: #bbb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blocked-hint {
  font-size: 11px;
  color: #555;
  margin-top: 8px;
}
</style>
