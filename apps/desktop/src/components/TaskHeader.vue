<script setup lang="ts">
import { computed, ref } from "vue";
import type { PipelineItem } from "../types/kanna";
import { useI18n } from "vue-i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../tauri-mock";

const { t } = useI18n();

const props = defineProps<{
  item: PipelineItem;
}>();

function title(item: PipelineItem): string {
  return item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
}

function taskPromptTooltip(item: PipelineItem): string | undefined {
  return item.prompt || undefined;
}

interface PortBadge {
  envName: string;
  port: number;
}

const ports = computed<PortBadge[]>(() => {
  if (!props.item.port_env) return [];
  try {
    const env = JSON.parse(props.item.port_env) as Record<string, string | number>;
    return Object.entries(env)
      .map(([envName, value]) => ({ envName, port: Number(value) }))
      .filter(({ port }) => !Number.isNaN(port))
      .sort((a, b) => a.port - b.port || a.envName.localeCompare(b.envName));
  } catch (error) {
    console.debug("[task-header] failed to parse task port_env:", error);
    return [];
  }
});

const copied = ref(false);
function copyBranch() {
  if (!props.item.branch) return;
  navigator.clipboard.writeText(props.item.branch);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}

function openLocalhostPort(port: number) {
  const url = `http://localhost:${port}`;
  if (isTauri) {
    openUrl(url).catch((error) => console.error("[task-header] Failed to open port:", error));
    return;
  }
  window.open(url, "_blank");
}
</script>

<template>
  <div class="task-header" @mousedown.prevent>
    <div class="header-top">
      <span class="stage-badge">{{ item.stage }}</span>
      <h2 class="task-title" :title="taskPromptTooltip(item)" @mousedown.stop>{{ title(item) }}</h2>
    </div>
    <div class="header-meta">
      <span v-if="item.branch" class="meta-item branch" @dblclick="copyBranch">
        <span class="meta-label">{{ $t('taskHeader.branchLabel') }}</span> {{ copied ? $t('taskHeader.copied', 'Copied!') : item.branch }}
      </span>
      <span
        v-for="portInfo in ports"
        :key="`${portInfo.envName}:${portInfo.port}`"
        class="meta-item port"
        :title="`${portInfo.envName}=${portInfo.port}`"
        @mousedown.stop
        @dblclick="openLocalhostPort(portInfo.port)"
      >
        :{{ portInfo.port }}
      </span>
      <a
        v-if="item.issue_number"
        class="meta-item link"
        :href="`#issue-${item.issue_number}`"
        @click.prevent
      >
        #{{ item.issue_number }}
      </a>
      <a
        v-if="item.pr_number && item.pr_url"
        class="meta-item link"
        :href="item.pr_url"
        target="_blank"
      >
        {{ $t('taskHeader.prPrefix') }}{{ item.pr_number }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.task-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-sidebar);
}

.header-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stage-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: var(--kn-accent);
  white-space: nowrap;
  line-height: 1.4;
  background: var(--kn-bg-accent-subtle);
  flex-shrink: 0;
}

.task-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kn-text-primary);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  cursor: text;
}

.header-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
}

.meta-item {
  color: var(--kn-text-muted);
}

.meta-label {
  color: var(--kn-text-muted);
}

.branch {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: var(--kn-bg-panel-raised);
  padding: 1px 6px;
  border-radius: 3px;
  cursor: default;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.port {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: var(--kn-bg-panel-raised);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--kn-success);
  cursor: pointer;
  flex-shrink: 0;
}

.link {
  color: var(--kn-accent);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}
</style>
