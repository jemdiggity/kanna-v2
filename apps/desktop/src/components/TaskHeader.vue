<script setup lang="ts">
import { computed } from "vue";
import type { PipelineItem } from "@kanna/db";
import StageBadge from "./StageBadge.vue";

const props = defineProps<{
  item: PipelineItem;
}>();

function title(item: PipelineItem): string {
  return item.display_name || item.issue_title || item.prompt || "Untitled";
}

const ports = computed<number[]>(() => {
  if (!props.item.port_env) return [];
  try {
    const env = JSON.parse(props.item.port_env) as Record<string, string | number>;
    return Object.values(env).map(Number).filter((n) => !isNaN(n));
  } catch {
    return [];
  }
});
</script>

<template>
  <div class="task-header">
    <div class="header-top">
      <StageBadge :stage="item.stage" />
      <h2 class="task-title">{{ title(item) }}</h2>
    </div>
    <div class="header-meta">
      <span v-if="item.branch" class="meta-item branch">
        <span class="meta-label">branch:</span> {{ item.branch }}
      </span>
      <span v-for="port in ports" :key="port" class="meta-item port">
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
        PR #{{ item.pr_number }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.task-header {
  padding: 12px 16px;
  border-bottom: 1px solid #333;
  background: #1e1e1e;
}

.header-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.task-title {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
}

.meta-item {
  color: #888;
}

.meta-label {
  color: #666;
}

.branch {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: #2a2a2a;
  padding: 1px 6px;
  border-radius: 3px;
}

.port {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: #2a2a2a;
  padding: 1px 6px;
  border-radius: 3px;
  color: #8a8;
}

.link {
  color: #4a9eff;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}
</style>
