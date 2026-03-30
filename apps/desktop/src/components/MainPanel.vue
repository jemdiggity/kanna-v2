<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import TaskHeader from "./TaskHeader.vue";
import TerminalTabs from "./TerminalTabs.vue";

const props = defineProps<{
  item: PipelineItem | null;
  activeSessionIds: Set<string>;
  activePtySessions?: Array<{
    sessionId: string;
    worktreePath?: string;
    prompt?: string;
    agentProvider?: string;
  }>;
  repoPath?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
  maximized?: boolean;
  blockers?: PipelineItem[];
  hasRepos?: boolean;
}>();

const emit = defineEmits<{
  (e: "agent-completed"): void;
  (e: "back"): void;
}>();

const isMobile = __KANNA_MOBILE__;

const isBlocked = computed(() => {
  if (!props.blockers || props.blockers.length === 0) return false;
  return props.blockers.some(b => !b.closed_at);
});

// --- Agent CLI detection ---

interface AgentCliStatus {
  installed: boolean;
  version?: string;
}

const claude = ref<AgentCliStatus>({ installed: false });
const copilot = ref<AgentCliStatus>({ installed: false });
const codex = ref<AgentCliStatus>({ installed: false });
const copiedAgent = ref<string | null>(null);

const INSTALL_COMMANDS: Record<string, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  copilot: "curl -fsSL https://gh.io/copilot-install | bash",
  codex: "npm install -g @openai/codex",
};

function parseSemver(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

async function checkCli(name: string): Promise<AgentCliStatus> {
  try {
    await invoke("which_binary", { name });
  } catch {
    return { installed: false };
  }
  try {
    const output = await invoke("run_script", {
      script: `${name} --version`,
      cwd: "/",
      env: {},
    }) as string;
    return { installed: true, version: parseSemver(output) };
  } catch {
    return { installed: true };
  }
}

async function checkAllClis() {
  const [c, p, x] = await Promise.all([checkCli("claude"), checkCli("copilot"), checkCli("codex")]);
  claude.value = c;
  copilot.value = p;
  codex.value = x;
}

watch(() => props.hasRepos, (has) => {
  if (!has) checkAllClis();
}, { immediate: true });

defineExpose({ recheckClis: checkAllClis });

async function copyCommand(agent: string) {
  const cmd = INSTALL_COMMANDS[agent];
  if (!cmd) return;
  await navigator.clipboard.writeText(cmd);
  copiedAgent.value = agent;
  setTimeout(() => { copiedAgent.value = null; }, 1500);
}
</script>

<template>
  <main class="main-panel">
    <template v-if="item">
      <div v-if="isMobile" class="mobile-back-bar" @click="emit('back')">
        <span class="mobile-back-arrow">&larr;</span>
        <span>Tasks</span>
      </div>
      <TaskHeader v-if="!maximized" :item="item" />
      <template v-if="isBlocked">
        <div class="blocked-placeholder">
          <p class="blocked-title">{{ $t('mainPanel.taskBlocked') }}</p>
          <p class="blocked-hint">{{ $t('mainPanel.taskBlockedHint') }}</p>
          <div v-if="blockers && blockers.length > 0" class="blocked-by">
            <p class="blocked-by-label">{{ $t('mainPanel.waitingOn') }}</p>
            <div v-for="b in blockers" :key="b.id" class="blocker-item">
              <span
                class="blocker-status"
                :style="{ color: b.closed_at != null ? '#666' : '#0066cc' }"
              >{{ b.closed_at != null ? $t('mainPanel.blockerDone') : $t('mainPanel.blockerActive') }}</span>
              <span class="blocker-name">{{ b.display_name || (b.prompt ? b.prompt.slice(0, 60) : $t('tasks.untitled')) }}</span>
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <TerminalTabs
          :session-id="item.id"
          :active-session-ids="activeSessionIds"
          :active-pty-sessions="activePtySessions"
          :agent-type="item.agent_type || 'pty'"
          :agent-provider="item.agent_provider || 'claude'"
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
        <div class="agent-setup">
          <p class="setup-title">{{ $t('mainPanel.agentSetupTitle') }}</p>
          <div class="agent-cards">
            <div v-for="agent in [
              { key: 'claude', nameKey: 'mainPanel.agentClaudeName', status: claude },
              { key: 'copilot', nameKey: 'mainPanel.agentCopilotName', status: copilot },
              { key: 'codex', nameKey: 'mainPanel.agentCodexName', status: codex },
            ]" :key="agent.key" class="agent-card">
              <div class="agent-header">
                <span class="agent-name">{{ $t(agent.nameKey) }}</span>
                <span v-if="agent.status.installed" class="agent-badge installed">
                  <span class="checkmark">✓</span>
                  {{ $t('mainPanel.agentVersion', { version: agent.status.version || '?' }) }}
                </span>
                <span v-else class="agent-badge not-installed">
                  {{ $t('mainPanel.agentNotInstalled') }}
                </span>
              </div>
              <div v-if="!agent.status.installed" class="install-block">
                <code class="install-cmd">{{ INSTALL_COMMANDS[agent.key] }}</code>
                <button
                  class="copy-btn"
                  :title="copiedAgent === agent.key ? $t('mainPanel.agentCopied') : 'Copy'"
                  @click="copyCommand(agent.key)"
                >
                  {{ copiedAgent === agent.key ? '✓' : '⧉' }}
                </button>
              </div>
            </div>
          </div>
          <p class="setup-hint">
            {{ $t('mainPanel.agentInstallHint', { shellShortcut: '⇧⌘J' }) }}
          </p>
          <p class="empty-hint">{{ $t('mainPanel.noReposHint', { shortcut: '⌘I' }) }}</p>
        </div>
      </template>
      <template v-else>
        <p class="empty-title">{{ $t('mainPanel.noTaskSelected') }}</p>
        <p class="empty-hint">{{ $t('mainPanel.noTaskHint', { shortcut: '⇧⌘N' }) }}</p>
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

.agent-setup {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  max-width: 480px;
  margin: 0 auto;
  padding: 32px;
}

.setup-title {
  font-size: 15px;
  font-weight: 500;
  color: #888;
  margin-bottom: 4px;
}

.agent-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.agent-card {
  background: #222;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 14px 16px;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.agent-name {
  font-size: 13px;
  font-weight: 600;
  color: #ccc;
}

.agent-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}

.agent-badge.installed {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
}

.agent-badge.not-installed {
  color: #888;
  background: #2a2a2a;
}

.checkmark {
  margin-right: 4px;
}

.install-block {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.install-cmd {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: #aaa;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  white-space: nowrap;
}

.copy-btn {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #aaa;
  font-size: 13px;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.copy-btn:hover {
  background: #333;
  color: #ccc;
}

.setup-hint {
  font-size: 12px;
  color: #555;
}

.mobile-back-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: #222;
  border-bottom: 1px solid #333;
  color: #4a9eff;
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.mobile-back-arrow {
  font-size: 18px;
}
</style>
