<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import TaskHeader from "./TaskHeader.vue";
import TerminalTabs from "./TerminalTabs.vue";
import CloudTerminalView from "./CloudTerminalView.vue";

const props = defineProps<{
  item: PipelineItem | null;
  repoPath?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
  recoverTaskSession?: (sessionId: string, options?: { cols?: number; rows?: number }) => Promise<void>;
  maximized?: boolean;
  blockers?: PipelineItem[];
  hasRepos?: boolean;
  pendingSetup?: boolean;
  cloudTask?: boolean;
  cloudTerminalRef?: {
    ownerDesktopId: string;
    ownerLocalTaskId: string;
    transport?: "cloud" | "lan";
  } | null;
}>();

const emit = defineEmits<{
  (e: "back"): void;
}>();

const isMobile = __KANNA_MOBILE__;
const COMMAND_HINT_STORAGE_KEY = "kanna:hide-command-hint";

const isBlocked = computed(() => {
  if (!props.blockers || props.blockers.length === 0) return false;
  return props.blockers.some(b => !b.closed_at);
});
const commandHintDismissed = ref(readCommandHintDismissed());
const showCommandHint = computed(() => !commandHintDismissed.value);

// --- Agent CLI detection ---

interface AgentCliStatus {
  installed: boolean;
  version?: string;
}

const claude = ref<AgentCliStatus>({ installed: false });
const copilot = ref<AgentCliStatus>({ installed: false });
const codex = ref<AgentCliStatus>({ installed: false });
const opencode = ref<AgentCliStatus>({ installed: false });
const copiedAgent = ref<string | null>(null);

const INSTALL_COMMANDS: Record<string, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  copilot: "curl -fsSL https://gh.io/copilot-install | bash",
  codex: "npm install -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
};

function parseSemver(output: string): string | undefined {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

async function readE2eCliVersion(name: string): Promise<string | undefined> {
  if (!import.meta.env.DEV) return undefined;
  const envName = `KANNA_E2E_AGENT_CLI_VERSION_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
  try {
    return await invoke<string>("read_env_var", { name: envName });
  } catch (error) {
    console.debug(`[main-panel] E2E CLI version override not set for ${name}:`, error);
    return undefined;
  }
}

async function checkCli(name: string): Promise<AgentCliStatus> {
  const e2eVersionOutput = await readE2eCliVersion(name);
  if (e2eVersionOutput !== undefined) {
    return { installed: true, version: parseSemver(e2eVersionOutput) };
  }

  try {
    await invoke("which_binary", { name });
  } catch (error) {
    console.debug(`[main-panel] CLI binary not found: ${name}`, error);
    return { installed: false };
  }
  try {
    const output = await invoke("run_script", {
      script: `${name} --version`,
      cwd: "/",
      env: {},
    }) as string;
    return { installed: true, version: parseSemver(output) };
  } catch (error) {
    console.debug(`[main-panel] failed to read CLI version for ${name}:`, error);
    return { installed: true };
  }
}

async function checkAllClis() {
  const [c, p, x, o] = await Promise.all([checkCli("claude"), checkCli("copilot"), checkCli("codex"), checkCli("opencode")]);
  claude.value = c;
  copilot.value = p;
  codex.value = x;
  opencode.value = o;
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

function readCommandHintDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COMMAND_HINT_STORAGE_KEY) === "1";
}

function dismissCommandHint() {
  commandHintDismissed.value = true;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(COMMAND_HINT_STORAGE_KEY, "1");
  }
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
                :style="{ color: b.closed_at != null ? 'var(--kn-text-muted)' : 'var(--kn-accent)' }"
              >{{ b.closed_at != null ? $t('mainPanel.blockerDone') : $t('mainPanel.blockerActive') }}</span>
              <span class="blocker-name">{{ b.display_name || (b.prompt ? b.prompt.slice(0, 60) : $t('tasks.untitled')) }}</span>
            </div>
          </div>
        </div>
      </template>
      <template v-else-if="pendingSetup">
        <div class="setup-placeholder">
          <p class="setup-title">{{ $t('mainPanel.taskSettingUp') }}</p>
        </div>
      </template>
      <template v-else-if="cloudTask">
        <CloudTerminalView
          v-if="cloudTerminalRef"
          :owner-desktop-id="cloudTerminalRef.ownerDesktopId"
          :owner-task-id="cloudTerminalRef.ownerLocalTaskId"
          :transport="cloudTerminalRef.transport"
        />
        <div v-else class="cloud-task-placeholder">
          <p class="cloud-task-title">Task is running on another machine</p>
          <p class="cloud-task-hint">Cloud sync is showing the task here, but terminal routing information is unavailable.</p>
        </div>
      </template>
      <template v-else>
        <TerminalTabs
          :session-id="item.id"
          :agent-type="item.agent_type || 'pty'"
          :agent-provider="item.agent_provider"
          :repo-path="repoPath"
          :worktree-path="item.branch ? `${repoPath}/.kanna-worktrees/${item.branch}` : undefined"
          :prompt="item.prompt || ''"
          :spawn-pty-session="spawnPtySession"
          :recover-task-session="recoverTaskSession"
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
              { key: 'opencode', nameKey: 'mainPanel.agentOpenCodeName', status: opencode },
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
    <div
      v-if="showCommandHint"
      data-testid="command-hint"
      class="command-hint"
    >
      <span class="command-hint-copy">
        <span v-if="$t('mainPanel.commandHintPrefix')" class="command-hint-text">
          {{ $t('mainPanel.commandHintPrefix') }}
        </span>
        <span class="command-hint-shortcut">
          <kbd>⌘</kbd><kbd>/</kbd>
        </span>
        <span class="command-hint-text">
          {{ $t('mainPanel.commandHintSuffix') }}
        </span>
      </span>
      <button
        data-testid="command-hint-dismiss"
        type="button"
        class="command-hint-dismiss"
        :aria-label="$t('actions.dismiss')"
        @click="dismissCommandHint"
      >
        ×
      </button>
    </div>
  </main>
</template>

<style scoped>
.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--kn-bg-app);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.setup-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kn-text-muted);
  font-size: 13px;
}

.cloud-task-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--kn-text-muted);
  font-size: 13px;
  text-align: center;
}

.cloud-task-title {
  margin: 0;
  color: var(--kn-text-primary);
  font-size: 14px;
}

.cloud-task-hint {
  margin: 0;
  max-width: 360px;
  line-height: 1.4;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--kn-text-muted);
}

.empty-hint {
  font-size: 12px;
  color: var(--kn-text-muted);
}

.empty-hint kbd {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--kn-text-muted);
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
  color: var(--kn-text-muted);
}

.blocked-prompt {
  font-size: 13px;
  color: var(--kn-text-muted);
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
  color: var(--kn-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.blocker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--kn-bg-panel);
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
  color: var(--kn-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blocked-hint {
  font-size: 11px;
  color: var(--kn-text-muted);
  margin-top: 8px;
}

.command-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  color: var(--kn-text-muted);
  font-size: 12px;
}

.command-hint-copy {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.command-hint-shortcut {
  display: inline-flex;
  align-items: center;
}

.command-hint-copy kbd {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--kn-text-secondary);
}

.command-hint-copy kbd + kbd {
  margin-left: 2px;
}

.command-hint-dismiss {
  border: 0;
  background: transparent;
  color: var(--kn-text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px;
}

.command-hint-dismiss:hover {
  color: var(--kn-text-muted);
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
  color: var(--kn-text-muted);
  margin-bottom: 4px;
}

.agent-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.agent-card {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-default);
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
  color: var(--kn-text-secondary);
}

.agent-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}

.agent-badge.installed {
  color: var(--kn-success);
  background: var(--kn-success-bg);
}

.agent-badge.not-installed {
  color: var(--kn-text-muted);
  background: var(--kn-bg-panel-raised);
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
  color: var(--kn-text-muted);
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-default);
  border-radius: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  white-space: nowrap;
}

.copy-btn {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-muted);
  font-size: 13px;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.copy-btn:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-secondary);
}

.setup-hint {
  font-size: 12px;
  color: var(--kn-text-muted);
}

.mobile-back-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: var(--kn-bg-panel-raised);
  border-bottom: 1px solid var(--kn-border-default);
  color: var(--kn-accent);
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.mobile-back-arrow {
  font-size: 18px;
}
</style>
