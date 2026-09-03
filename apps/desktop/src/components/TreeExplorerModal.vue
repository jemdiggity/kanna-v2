<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, toRef } from "vue";
import {
  useTreeExplorer,
  type RemoteDirectoryLoader,
  type TreeNode,
} from "../composables/useTreeExplorer";
import { useShortcutContext, registerContextShortcuts } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useModalTearOff } from "../composables/useModalTearOff";

useShortcutContext("tree");
registerContextShortcuts("tree", [
  { label: "Filter", display: "/", groupKey: "shortcuts.groupSearch" },
  { label: "Clear filter", display: "Esc", groupKey: "shortcuts.groupSearch" },
  { label: "Move ↓ / ↑", display: "j / k", groupKey: "shortcuts.groupNavigation" },
  { label: "Enter dir / Open file", display: "l", groupKey: "shortcuts.groupNavigation" },
  { label: "Go to parent", display: "h", groupKey: "shortcuts.groupNavigation" },
  { label: "Top / Bottom", display: "g g / G", groupKey: "shortcuts.groupNavigation" },
  { label: "Toggle show all files", display: "a", groupKey: "shortcuts.groupActions" },
  { label: "Yank path", display: "y", groupKey: "shortcuts.groupActions" },
  { label: "Close", display: "Esc", groupKey: "shortcuts.groupActions" },
]);

const { zIndex, bringToFront } = useModalZIndex();

function dismiss(): boolean {
  if (filtering.value || filterText.value) {
    filterText.value = "";
    filtering.value = false;
    return false;
  }
  return true;
}

defineExpose({ zIndex, bringToFront, dismiss });

const props = defineProps<{
  worktreePath: string;
  repoRoot: string;
  homePath?: string;
  maximized?: boolean;
  suspended?: boolean;
  standalone?: boolean;
  remoteDirectoryLoader?: RemoteDirectoryLoader;
  remoteDesktopId?: string;
  remoteTaskId?: string;
}>();

const rootLabel = computed(() => {
  if (props.homePath && props.worktreePath === props.homePath) return "~";
  const parts = props.worktreePath.split("/");
  return parts[parts.length - 1] || props.worktreePath;
});

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-file", filePath: string): void;
}>();

const modalRef = ref<HTMLElement | null>(null);
const currentColRef = ref<HTMLElement | null>(null);

const tearOff = useModalTearOff({
  enabled: computed(() => !props.standalone),
  modalRef,
  handleSelector: ".breadcrumb-bar",
  getContext: () => ({
    surface: "tree",
    worktreePath: props.worktreePath,
    repoRoot: props.repoRoot,
    ...(props.homePath ? { homePath: props.homePath } : {}),
    ...(props.remoteDesktopId ? { remoteDesktopId: props.remoteDesktopId } : {}),
    ...(props.remoteTaskId ? { remoteTaskId: props.remoteTaskId } : {}),
  }),
  onTornOff: () => emit("close"),
});

const {
  state,
  showAllFiles,
  filterText,
  filtering,
  loading,
  error,
  slideDirection,
  handleKey,
  activateCurrentEntry,
  activateParentEntry,
  activatePreviewEntry,
  activateSelectedEntry,
  exitCurrentDirectory,
  currentFilePath,
  jumpToBreadcrumb,
  toggleShowAllFiles,
  reset,
} = useTreeExplorer(
  toRef(props, "worktreePath"),
  toRef(props, "repoRoot"),
  toRef(props, "remoteDirectoryLoader"),
);

const HORIZONTAL_WHEEL_THRESHOLD = 64;
const HORIZONTAL_WHEEL_COOLDOWN_MS = 220;
let horizontalWheelDelta = 0;
let lastHorizontalNavigationAt = 0;
let lastHorizontalNavigationDirection: "enter" | "exit" | null = null;

async function onKeydown(e: KeyboardEvent) {
  // Let meta/ctrl combos bubble to global shortcuts (⌘J, ⌘D, etc.)
  if (e.metaKey || e.ctrlKey) return;

  // Stop propagation — tree explorer owns all non-meta keys
  e.stopPropagation();

  if (e.key === "Escape") {
    e.preventDefault();
    if (dismiss()) {
      emit("close");
    }
    return;
  }

  if (e.key === "y") {
    if (currentFilePath.value) {
      e.preventDefault();
      await navigator.clipboard.writeText(currentFilePath.value);
      return;
    }
  }

  if (e.key === "a" && !filtering.value) {
    e.preventDefault();
    toggleShowAllFiles();
    return;
  }

  const filePath = handleKey(e);
  emitOpenedFile(filePath);
}

function onWheel(e: WheelEvent) {
  const horizontal = Math.abs(e.deltaX);
  const vertical = Math.abs(e.deltaY);

  if (horizontal < 12 || horizontal <= vertical * 1.15) return;

  e.preventDefault();
  e.stopPropagation();

  horizontalWheelDelta += e.deltaX;

  const now = performance.now();
  if (Math.abs(horizontalWheelDelta) < HORIZONTAL_WHEEL_THRESHOLD) {
    return;
  }

  const direction = horizontalWheelDelta > 0 ? "enter" : "exit";
  if (
    direction === lastHorizontalNavigationDirection &&
    now - lastHorizontalNavigationAt < HORIZONTAL_WHEEL_COOLDOWN_MS
  ) {
    return;
  }

  horizontalWheelDelta = 0;
  lastHorizontalNavigationAt = now;
  lastHorizontalNavigationDirection = direction;

  if (direction === "enter") {
    emitOpenedFile(activateSelectedEntry());
  } else {
    exitCurrentDirectory();
  }
}

onMounted(() => {
  nextTick(() => modalRef.value?.focus());
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

function emitOpenedFile(filePath: string | null) {
  if (filePath) {
    emit("open-file", filePath);
  }
}

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
  <div
    v-show="!suspended"
    class="modal-overlay"
    :class="{ maximized, standalone }"
    :style="{ zIndex }"
    @click.self="emit('close')"
  >
    <div
      ref="modalRef"
      class="tree-modal"
      tabindex="-1"
      @keydown="onKeydown"
      @pointerdown="tearOff.onPointerDown"
      @pointermove="tearOff.onPointerMove"
      @pointerup="tearOff.onPointerUp"
      @pointercancel="tearOff.onPointerCancel"
    >
      <!-- Breadcrumb bar -->
      <div class="breadcrumb-bar">
        <span
          class="breadcrumb-segment breadcrumb-root"
          data-no-tear-off
          @click="jumpToBreadcrumb(0)"
        >{{ rootLabel }}</span>
        <template v-for="(seg, i) in state.breadcrumb" :key="i">
          <span class="breadcrumb-sep">/</span>
          <span
            class="breadcrumb-segment"
            data-no-tear-off
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
        @wheel="onWheel"
      >
        <!-- Parent column -->
        <div class="miller-col col-parent">
          <div class="col-scroll">
            <div
              v-for="(entry, index) in state.columns[0]"
              :key="entry.path"
              class="tree-item"
              :class="{ active: isInPath(entry) }"
              @click.stop="emitOpenedFile(activateParentEntry(index))"
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
              @click.stop="emitOpenedFile(activateCurrentEntry(index))"
            >
              <span v-if="entry.isDir" class="dir-arrow">&#x25B8;</span>
              <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
            </div>
          </div>
          <div v-if="loading" class="col-loading">&middot;&middot;&middot;</div>
          <div v-else-if="error" class="col-error" role="alert" data-testid="tree-explorer-unavailable">{{ error }}</div>
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
              @click.stop="emitOpenedFile(activatePreviewEntry(index))"
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
        <div class="filter-text">
          <span v-if="filtering">
            /{{ filterText }}<span class="filter-caret">|</span>
            <span class="filter-hint"> (Enter confirm &middot; Esc cancel)</span>
          </span>
          <span v-else-if="filterText">
            filter: <strong>{{ filterText }}</strong>
            <span class="filter-hint"> (/ to edit &middot; Esc to close)</span>
          </span>
          <span v-else class="filter-hint">/ filter &middot; Esc close</span>
        </div>
        <span class="filter-actions">
          <button
            type="button"
            class="show-all-toggle"
            :class="{ active: showAllFiles }"
            @click.prevent="toggleShowAllFiles"
          >
            {{ showAllFiles ? "showing all" : "showing visible" }}
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--kn-overlay-scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
}

.tree-modal {
  width: 780px;
  height: 60vh;
  background: var(--kn-bg-panel);
  border-radius: 10px;
  border: 1px solid var(--kn-border-default);
  display: flex;
  flex-direction: column;
  outline: none;
  overflow: hidden;
  box-shadow: var(--kn-shadow-modal);
}

.maximized {
  background: none;
  align-items: stretch;
  padding-top: 0;
}

.maximized .tree-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
  box-shadow: none;
}

.modal-overlay.standalone {
  background: none;
  align-items: stretch;
  padding: 0;
}

.standalone .tree-modal {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

/* Breadcrumb */
.breadcrumb-bar {
  padding: 10px 14px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: var(--kn-text-muted);
  border-bottom: 1px solid var(--kn-border-default);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
  user-select: none;
}

.breadcrumb-segment {
  color: var(--kn-text-secondary);
  cursor: pointer;
}

.breadcrumb-segment:hover {
  color: var(--kn-warning);
}

.breadcrumb-root {
  color: var(--kn-text-muted);
}

.breadcrumb-sep {
  margin: 0 2px;
  color: var(--kn-text-muted);
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
  border-left: 1px solid var(--kn-border-default);
}

.col-current {
  border-left: 2px solid var(--kn-accent) !important;
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
  color: var(--kn-text-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    opacity 120ms ease,
    transform 120ms ease;
}

.tree-item:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-primary);
  transform: translateX(2px);
}

.tree-item.cursor {
  background: var(--kn-bg-accent-subtle);
  border-left: 2px solid var(--kn-warning);
  padding-left: 8px;
  color: var(--kn-text-primary);
}

.tree-item:active {
  transform: translateX(3px) scale(0.995);
}

.tree-item.active {
  color: var(--kn-accent);
}

.tree-item.dimmed {
  opacity: 0.3;
}

.dir-arrow {
  width: 14px;
  flex-shrink: 0;
  color: var(--kn-warning);
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
  color: var(--kn-text-muted);
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
  color: var(--kn-danger);
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
  border-top: 1px solid var(--kn-border-default);
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--kn-text-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.filter-text {
  color: var(--kn-text-secondary);
}

.filter-text strong {
  color: var(--kn-warning);
}

.filter-bar.filter-active {
  background: var(--kn-bg-input);
  border-top-color: var(--kn-accent);
}

.filter-caret {
  color: var(--kn-warning);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.filter-hint {
  color: var(--kn-text-muted);
  margin-left: 4px;
}

.filter-actions {
  display: flex;
  align-items: center;
  margin-left: auto;
  gap: 8px;
  color: var(--kn-text-secondary);
}

.show-all-toggle {
  border: 1px solid var(--kn-border-strong);
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-primary);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
}

.show-all-toggle:hover {
  background: var(--kn-bg-panel-raised);
}

.show-all-toggle.active {
  border-color: var(--kn-warning);
  color: var(--kn-warning);
}
</style>
