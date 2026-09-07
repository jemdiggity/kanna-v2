<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { MainTab } from "../composables/useMainTabs";

const props = defineProps<{
  tabs: MainTab[];
  activeTabId: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "close", id: string): void;
}>();

const { t } = useI18n();

interface MainTabPresentation {
  id: string;
  label: string;
  title: string;
  closable: boolean;
}

function fileName(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  return segments.at(-1) ?? filePath;
}

const presented = computed<MainTabPresentation[]>(() =>
  props.tabs.map((tab) => {
    switch (tab.kind) {
      case "agent":
        return {
          id: tab.id,
          label: t("mainTabs.agent"),
          title: t("mainTabs.agent"),
          closable: false,
        };
      case "diff":
        return {
          id: tab.id,
          label: t("mainTabs.diff"),
          title: t("mainTabs.diff"),
          closable: true,
        };
      case "shell":
        return {
          id: tab.id,
          label: t("mainTabs.shell"),
          title: t("mainTabs.shell"),
          closable: true,
        };
      case "file":
        return {
          id: tab.id,
          label: fileName(tab.filePath ?? ""),
          title: tab.filePath ?? "",
          closable: true,
        };
    }
  })
);
</script>

<template>
  <div class="main-tab-bar" role="tablist" data-testid="main-tab-bar">
    <div
      v-for="tab in presented"
      :key="tab.id"
      class="main-tab"
      :class="{ active: tab.id === activeTabId }"
      role="tab"
      :aria-selected="tab.id === activeTabId"
      :title="tab.title"
      :data-testid="`main-tab-${tab.id}`"
      @click="emit('select', tab.id)"
      @auxclick.middle.prevent="tab.closable && emit('close', tab.id)"
    >
      <span class="main-tab-label">{{ tab.label }}</span>
      <button
        v-if="tab.closable"
        type="button"
        class="main-tab-close"
        :aria-label="$t('actions.close')"
        :data-testid="`main-tab-close-${tab.id}`"
        @click.stop="emit('close', tab.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.main-tab-bar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-sidebar);
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
}

.main-tab-bar::-webkit-scrollbar {
  display: none;
}

.main-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 6px 8px 5px;
  border-bottom: 2px solid transparent;
  color: var(--kn-text-muted);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.main-tab:hover {
  color: var(--kn-text-secondary);
  background: var(--kn-bg-hover);
}

.main-tab.active {
  color: var(--kn-text-primary);
  border-bottom-color: var(--kn-accent);
}

.main-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.main-tab-close {
  border: 0;
  padding: 0 2px;
  background: transparent;
  color: var(--kn-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  visibility: hidden;
}

.main-tab:hover .main-tab-close,
.main-tab.active .main-tab-close {
  visibility: visible;
}

.main-tab-close:hover {
  color: var(--kn-text-primary);
}
</style>
