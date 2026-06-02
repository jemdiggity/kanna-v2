<script setup lang="ts">
import { computed, ref } from "vue";
import type { PipelineItem } from "@kanna/db";
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

const ports = computed<number[]>(() => {
  if (!props.item.port_env) return [];
  try {
    const env = JSON.parse(props.item.port_env) as Record<string, string | number>;
    return Object.values(env)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  } catch {
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
      <h2 class="task-title" @mousedown.stop>{{ title(item) }}</h2>
    </div>
    <div class="header-meta">
      <span v-if="item.branch" class="meta-item branch" @dblclick="copyBranch">
        <span class="meta-label">{{ $t('taskHeader.branchLabel') }}</span> {{ copied ? $t('taskHeader.copied', 'Copied!') : item.branch }}
      </span>
      <span
        v-for="port in ports"
        :key="port"
        class="meta-item port"
        :title="`Open localhost:${port}`"
        @mousedown.stop
        @dblclick="openLocalhostPort(port)"
      >
        :{{ port }}
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
}

.port {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: var(--kn-bg-panel-raised);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--kn-success);
  cursor: pointer;
}

.link {
  color: var(--kn-accent);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}
</style>
