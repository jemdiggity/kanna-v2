<script setup lang="ts">
import type { AgentProvider } from "../types/kanna";
import AgentMessageView from "./AgentMessageView.vue";
import TerminalView from "./TerminalView.vue";
import { shouldEnableKittyKeyboard } from "../composables/terminalSessionRecovery";
import { buildTerminalSpawnOptions } from "../composables/terminalSpawnOptions";

const taskTerminalWarmCacheMax = 10;

const props = defineProps<{
  sessionId: string | null;
  /** False while another main-area tab is in front of the agent session. */
  active?: boolean;
  agentType?: string;
  agentProvider?: AgentProvider;
  worktreePath?: string;
  repoPath?: string;
  prompt?: string;
  spawnPtySession?: (
    sessionId: string,
    cwd: string,
    prompt: string,
    cols: number,
    rows: number,
    options?: { agentProvider?: AgentProvider },
  ) => Promise<void>;
  recoverTaskSession?: (sessionId: string, options?: { cols?: number; rows?: number }) => Promise<void>;
}>();

function buildSpawnOptions() {
  return buildTerminalSpawnOptions(props.spawnPtySession, {
    worktreePath: props.worktreePath,
    prompt: props.prompt,
    agentProvider: props.agentProvider,
  });
}
</script>

<template>
  <div class="terminal-panel">
    <!-- PTY mode: mount only the active terminal view -->
    <KeepAlive :max="taskTerminalWarmCacheMax">
      <TerminalView
        v-if="sessionId && agentType === 'pty'"
        :key="sessionId"
        :session-id="sessionId"
        :active="active !== false"
        :spawn-options="buildSpawnOptions()"
        :kitty-keyboard="!!(spawnPtySession && worktreePath && prompt) && shouldEnableKittyKeyboard({ agentProvider })"
        :agent-provider="agentProvider"
        :worktree-path="worktreePath"
        :agent-terminal="true"
        :recover-session="recoverTaskSession"
      />
    </KeepAlive>
    <AgentMessageView
      v-if="sessionId && agentType === 'agent'"
      :key="sessionId"
      :session-id="sessionId"
      :agent-provider="agentProvider"
      :worktree-path="worktreePath"
      :recover-session="recoverTaskSession"
    />
    <div v-if="!sessionId" class="placeholder">
      {{ $t('terminalTabs.noSession') }}
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kn-text-muted);
  font-size: 13px;
}
</style>
