<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { macOsTextInputAttrs } from "../utils/textInput";
import {
  filterBaseBranchCandidates,
  getDefaultBaseBranch,
} from "../utils/baseBranchPicker";

interface PreviewProps {
  baseBranches?: string[];
  defaultBranchName?: string;
}

const props = withDefaults(defineProps<PreviewProps>(), {
  defaultBranchName: "main",
  baseBranches: () => [
    "origin/main",
    "main",
    "feature/agent-terminal-redraw",
    "feature/base-branch-dropdown",
    "feature/commit-graph-jump",
    "feature/task-list-density",
    "feature/worktree-cleanup",
    "feature/command-palette-filtering",
    "feature/sidebar-operator-metrics",
    "fix/branch-modal-overflow",
    "fix/shell-reconnect",
    "fix/task-creation-focus",
    "release/2026.04",
    "release/2026.05",
  ],
});

const MAX_VISIBLE_BRANCH_ROWS = 7;
const BRANCH_ROW_HEIGHT_PX = 36;

const showDropdown = ref(false);
const query = ref("");
const selectedIndex = ref(0);
const selectedBaseBranch = ref(
  getDefaultBaseBranch(props.baseBranches, props.defaultBranchName),
);
const searchRef = ref<HTMLInputElement | null>(null);

const visibleBaseBranches = computed(() =>
  filterBaseBranchCandidates(props.baseBranches, query.value, props.defaultBranchName),
);

watch(query, () => {
  selectedIndex.value = 0;
});

watch(showDropdown, async (open) => {
  if (open) {
    query.value = "";
    selectedIndex.value = Math.max(0, visibleBaseBranches.value.indexOf(selectedBaseBranch.value));
    await nextTick();
    searchRef.value?.focus();
    return;
  }

  query.value = "";
  selectedIndex.value = 0;
});

const listMaxHeight = `${MAX_VISIBLE_BRANCH_ROWS * BRANCH_ROW_HEIGHT_PX}px`;

function toggleDropdown() {
  showDropdown.value = !showDropdown.value;
}

function closeDropdown() {
  showDropdown.value = false;
}

function selectBranch(branch: string) {
  selectedBaseBranch.value = branch;
  closeDropdown();
}

function clampSelectedIndex(nextIndex: number): number {
  if (visibleBaseBranches.value.length === 0) return 0;
  return Math.min(Math.max(nextIndex, 0), visibleBaseBranches.value.length - 1);
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDropdown();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectedIndex.value = clampSelectedIndex(selectedIndex.value + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectedIndex.value = clampSelectedIndex(selectedIndex.value - 1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const branch = visibleBaseBranches.value[selectedIndex.value];
    if (branch) selectBranch(branch);
  }
}
</script>

<template>
  <main class="preview-page">
    <section class="preview-card">
      <p class="eyebrow">Mock UI</p>
      <h1>New Task Base Branch Dropdown</h1>
      <p class="description">
        Compact branch chooser preview for long branch lists. The dropdown keeps the modal height stable
        and limits the visible branch results to about seven rows.
      </p>

      <div class="mock-modal">
        <div class="field">
          <label class="field-label">Base branch</label>
          <div class="dropdown-shell">
            <button
              type="button"
              class="dropdown-trigger"
              data-testid="base-branch-dropdown-trigger"
              @click="toggleDropdown"
            >
              <span data-testid="selected-base-branch">{{ selectedBaseBranch }}</span>
              <span class="caret">{{ showDropdown ? "▴" : "▾" }}</span>
            </button>

            <div
              v-if="showDropdown"
              class="dropdown-panel"
              data-testid="base-branch-dropdown"
            >
              <input
                ref="searchRef"
                v-model="query"
                v-bind="macOsTextInputAttrs"
                type="text"
                class="search-input"
                placeholder="Search branches..."
                data-testid="base-branch-search"
                @keydown="handleSearchKeydown"
              />

              <div
                class="branch-options"
                :style="{ maxHeight: listMaxHeight }"
                data-testid="base-branch-options"
              >
                <button
                  v-for="(branch, index) in visibleBaseBranches"
                  :key="branch"
                  type="button"
                  class="branch-option"
                  :class="{ selected: branch === selectedBaseBranch, active: index === selectedIndex }"
                  :data-testid="`base-branch-option-${branch}`"
                  @mouseenter="selectedIndex = index"
                  @click="selectBranch(branch)"
                >
                  {{ branch }}
                </button>

                <div v-if="visibleBaseBranches.length === 0" class="empty-state">
                  No branches match this query.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.preview-page {
  min-height: 100vh;
  margin: 0;
  padding: 56px 20px;
  background: var(--kn-bg-app);
  color: var(--kn-text-primary);
  font-family: "SF Pro Display", "Inter Tight", "Segoe UI", sans-serif;
}

.preview-card {
  width: min(680px, 100%);
  margin: 0 auto;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--kn-accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.preview-card h1 {
  margin: 0;
  font-size: clamp(30px, 5vw, 42px);
  line-height: 1.05;
}

.description {
  max-width: 56ch;
  margin: 12px 0 28px;
  color: var(--kn-text-secondary);
  font-size: 15px;
  line-height: 1.6;
}

.mock-modal {
  padding: 20px;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 16px;
  box-shadow: var(--kn-shadow-modal);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  color: var(--kn-text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.dropdown-shell {
  position: relative;
}

.dropdown-trigger {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 10px;
  color: var(--kn-text-primary);
  cursor: pointer;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  text-align: left;
}

.dropdown-trigger:hover {
  border-color: var(--kn-accent);
}

.caret {
  color: var(--kn-accent);
  font-size: 12px;
}

.dropdown-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 10;
  overflow: hidden;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 12px;
  box-shadow: var(--kn-shadow-modal);
}

.search-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--kn-bg-input);
  border: 0;
  border-bottom: 1px solid var(--kn-border-default);
  color: var(--kn-text-primary);
  font-size: 13px;
  outline: none;
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.branch-options {
  overflow-y: auto;
}

.branch-option {
  width: 100%;
  min-height: 36px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--kn-text-secondary);
  cursor: pointer;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  text-align: left;
}

.branch-option:hover,
.branch-option.active {
  background: var(--kn-bg-hover);
}

.branch-option.selected {
  color: var(--kn-accent);
  font-weight: 600;
}

.empty-state {
  padding: 16px 12px;
  color: var(--kn-text-muted);
  font-size: 13px;
}

@media (max-width: 640px) {
  .preview-page {
    padding: 28px 14px;
  }

  .mock-modal {
    padding: 16px;
  }
}
</style>
