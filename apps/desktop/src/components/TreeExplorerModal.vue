<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, toRef } from "vue";
import { useTreeExplorer, type TreeNode } from "../composables/useTreeExplorer";
import { useShortcutContext, registerContextShortcuts } from "../composables/useShortcutContext";

useShortcutContext("tree");
registerContextShortcuts("tree", [
  { label: "Move ↓ / ↑", display: "j / k" },
  { label: "Enter dir / Open file", display: "l" },
  { label: "Go to parent", display: "h" },
  { label: "Yank path", display: "y" },
  { label: "Top / Bottom", display: "g g / G" },
  { label: "Filter", display: "/" },
  { label: "Clear filter", display: "Esc" },
  { label: "Close", display: "Esc" },
]);

const props = defineProps<{
  worktreePath: string;
  repoRoot: string;
  suspended?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-file", filePath: string): void;
}>();

const modalRef = ref<HTMLElement | null>(null);
const currentColRef = ref<HTMLElement | null>(null);

const {
  state,
  filterText,
  filtering,
  loading,
  error,
  slideDirection,
  open,
  handleKey,
  currentFilePath,
  jumpToBreadcrumb,
  reset,
} = useTreeExplorer(
  () => props.worktreePath,
  () => props.repoRoot
);

async function onKeydown(e: KeyboardEvent) {
  // Let meta/ctrl combos bubble to global shortcuts (⌘J, ⌘D, etc.)
  if (e.metaKey || e.ctrlKey) return;

  // Stop propagation — tree explorer owns all non-meta keys
  e.stopPropagation();

  if (e.key === "Escape" && !filtering.value && !filterText.value) {
    e.preventDefault();
    emit("close");
    return;
  }

  if (e.key === "y") {
    const path = currentFilePath();
    if (path) {
      e.preventDefault();
      await navigator.clipboard.writeText(path);
      return;
    }
  }

  const filePath = await handleKey(e);
  if (filePath) {
    emit("open-file", filePath);
  }
}

onMounted(async () => {
  await open();
  await nextTick();
  modalRef.value?.focus();
});

onUnmounted(() => {
  reset();
});

// Re-focus when returning from file preview
watch(toRef(props, "suspended"), (val) => {
  if (!val) nextTick(() => modalRef.value?.focus());
});

// Scroll active item into view when cursor changes
watch(
  () => state.value.cursor[1],
  (idx) => {
    const el = currentColRef.value?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }
);

function isInPath(entry: TreeNode): boolean {
  const bc = state.value.breadcrumb;
  return bc.length > 0 && entry.name === bc[bc.length - 1];
}

function isDimmed(entry: TreeNode): boolean {
  if (!filterText.value) return false;
  return !entry.name.toLowerCase().includes(filterText.value.toLowerCase());
}
</script>

<template>
  <div v-show="!suspended" class="modal-overlay" @click.self="emit('close')">
    <div
      ref="modalRef"
      class="tree-modal"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <!-- Breadcrumb bar -->
      <div class="breadcrumb-bar">
        <span
          class="breadcrumb-segment breadcrumb-root"
          @click="jumpToBreadcrumb(0)"
        >~</span>
        <template v-for="(seg, i) in state.breadcrumb" :key="i">
          <span class="breadcrumb-sep">/</span>
          <span
            class="breadcrumb-segment"
            @click="jumpToBreadcrumb(i + 1)"
          >{{ seg }}</span>
        </template>
        <span class="breadcrumb-sep">/</span>
      </div>

      <!-- Miller columns -->
      <div
        class="miller-columns"
        :class="{
          'slide-left': slideDirection === 'left',
          'slide-right': slideDirection === 'right',
        }"
      >
        <!-- Parent column -->
        <div class="miller-col col-parent">
          <div class="col-scroll">
            <div
              v-for="entry in state.columns[0]"
              :key="entry.path"
              class="tree-item"
              :class="{ active: isInPath(entry) }"
            >
              <span v-if="entry.isDir" class="dir-arrow">{{ isInPath(entry) ? '&#x25BE;' : '&#x25B8;' }}</span>
              <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
            </div>
          </div>
          <div v-if="state.columns[0].length === 0" class="col-empty">(root)</div>
        </div>

        <!-- Current column (active) -->
        <div class="miller-col col-current">
          <div ref="currentColRef" class="col-scroll">
            <div
              v-for="(entry, index) in state.columns[1]"
              :key="entry.path"
              class="tree-item"
              :class="{
                cursor: index === state.cursor[1],
                dimmed: isDimmed(entry),
              }"
            >
              <span v-if="entry.isDir" class="dir-arrow">&#x25B8;</span>
              <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
            </div>
          </div>
          <div v-if="loading" class="col-loading">&middot;&middot;&middot;</div>
          <div v-else-if="error" class="col-error">{{ error }}</div>
          <div v-else-if="state.columns[1].length === 0" class="col-empty">(empty)</div>
        </div>

        <!-- Preview column -->
        <div class="miller-col col-preview">
          <div class="col-scroll">
            <div
              v-for="(entry, index) in state.columns[2]"
              :key="entry.path"
              class="tree-item"
              :class="{ cursor: index === state.cursor[2] }"
            >
              <span v-if="entry.isDir" class="dir-arrow">&#x25B8;</span>
              <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
            </div>
          </div>
          <div v-if="state.columns[2].length === 0 && !loading" class="col-empty">
            {{ state.columns[1].length > 0 ? '(no preview)' : '' }}
          </div>
        </div>
      </div>

      <!-- Filter bar -->
      <div class="filter-bar" :class="{ 'filter-active': filtering }">
        <span v-if="filtering" class="filter-text">
          /{{ filterText }}<span class="filter-caret">|</span>
          <span class="filter-hint">(Enter confirm &middot; Esc cancel)</span>
        </span>
        <span v-else-if="filterText" class="filter-text">
          filter: <strong>{{ filterText }}</strong>
          <span class="filter-hint">(/ to edit &middot; Esc to close)</span>
        </span>
        <span v-else class="filter-hint">/ filter &middot; Esc close</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  z-index: 1000;
}

.tree-modal {
  width: 780px;
  height: 60vh;
  background: #1e1e1e;
  border-radius: 10px;
  border: 1px solid #333;
  display: flex;
  flex-direction: column;
  outline: none;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

/* Breadcrumb */
.breadcrumb-bar {
  padding: 10px 14px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #888;
  border-bottom: 1px solid #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.breadcrumb-segment {
  color: #ccc;
  cursor: pointer;
}

.breadcrumb-segment:hover {
  color: #ffcc00;
}

.breadcrumb-root {
  color: #888;
}

.breadcrumb-sep {
  margin: 0 2px;
  color: #555;
}

/* Miller columns */
.miller-columns {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.miller-columns.slide-left {
  animation: slide-left 180ms cubic-bezier(0, 0, .2, 1);
}

.miller-columns.slide-right {
  animation: slide-right 180ms cubic-bezier(0, 0, .2, 1);
}

@keyframes slide-left {
  from { transform: translateX(33.33%); }
  to { transform: translateX(0); }
}

@keyframes slide-right {
  from { transform: translateX(-33.33%); }
  to { transform: translateX(0); }
}

.miller-col {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.miller-col + .miller-col {
  border-left: 1px solid #333;
}

.col-current {
  border-left: 2px solid #0066cc !important;
}

.col-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Tree items */
.tree-item {
  height: 28px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #888;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item:hover {
  background: #333;
}

.tree-item.cursor {
  background: #0066cc44;
  border-left: 2px solid #ffcc00;
  padding-left: 8px;
  color: #fff;
}

.tree-item.active {
  color: #0066cc;
}

.tree-item.dimmed {
  opacity: 0.3;
}

.dir-arrow {
  width: 14px;
  flex-shrink: 0;
  color: #ffcc00;
  font-size: 10px;
}

.entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Empty / loading states */
.col-empty,
.col-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  pointer-events: none;
}

.col-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e55;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  padding: 12px;
  text-align: center;
  word-break: break-word;
}

.col-loading {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* Filter bar */
.filter-bar {
  padding: 8px 14px;
  border-top: 1px solid #333;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #888;
}

.filter-text {
  color: #ccc;
}

.filter-text strong {
  color: #ffcc00;
}

.filter-bar.filter-active {
  background: #1a1a1a;
  border-top-color: #0066cc;
}

.filter-caret {
  color: #ffcc00;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.filter-hint {
  color: #555;
  margin-left: 4px;
}
</style>
