<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import type { PipelineItem } from "@kanna/db";
import { useModalZIndex } from "../composables/useModalZIndex";
import { macOsTextInputAttrs } from "../utils/textInput";

const { t } = useI18n();
const { zIndex } = useModalZIndex();

const props = defineProps<{
  candidates: PipelineItem[];
  disabledIds?: string[];
  preselected?: string[];
  title: string;
}>();

const emit = defineEmits<{
  (e: "confirm", selectedIds: string[]): void;
  (e: "cancel"): void;
}>();

const query = ref("");
const selected = ref<Set<string>>(new Set(props.preselected || []));
const selectedIndex = ref(-1);
const inputRef = ref<HTMLInputElement | null>(null);
const mouseMoved = ref(false);

function hasTag(item: { tags: string }, tag: string): boolean {
  try {
    return (JSON.parse(item.tags) as string[]).includes(tag);
  } catch (error) {
    console.debug("[blocker-select] failed to parse task tags:", error);
    return false;
  }
}

const disabledSet = computed(() => new Set(props.disabledIds || []));

function isDisabled(id: string): boolean {
  return disabledSet.value.has(id);
}

function sortName(item: PipelineItem): string {
  return (item.display_name || item.issue_title || item.prompt || "").toLowerCase();
}

// Only show candidates that aren't already selected, sorted alphabetically
const filtered = computed(() => {
  const base = props.candidates.filter((c) => !selected.value.has(c.id));
  const q = query.value.toLowerCase();
  const results = q
    ? base.filter((c) => sortName(c).includes(q))
    : base;
  return results.sort((a, b) => sortName(a).localeCompare(sortName(b)));
});

const selectedItems = computed(() =>
  props.candidates.filter((c) => selected.value.has(c.id))
);

function addItem(id: string) {
  if (isDisabled(id)) return;
  selected.value.add(id);
  query.value = "";
  selectedIndex.value = -1;
  inputRef.value?.focus();
}

function removeItem(id: string) {
  selected.value.delete(id);
  inputRef.value?.focus();
}

function chipTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  return raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
}

function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  return raw.length > 60 ? raw.slice(0, 60) + "..." : raw;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault();
    e.stopPropagation();
    let next = selectedIndex.value + 1;
    while (next < filtered.value.length && isDisabled(filtered.value[next].id)) next++;
    if (next < filtered.value.length) selectedIndex.value = next;
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault();
    e.stopPropagation();
    let prev = selectedIndex.value - 1;
    while (prev >= 0 && isDisabled(filtered.value[prev].id)) prev--;
    if (prev >= 0) selectedIndex.value = prev;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedIndex.value >= 0 && filtered.value[selectedIndex.value]) {
      // Item highlighted — add it
      addItem(filtered.value[selectedIndex.value].id);
    } else {
      // Nothing highlighted — confirm selection
      emit("confirm", [...selected.value]);
    }
  } else if (e.key === "Backspace" && query.value === "") {
    // Backspace on empty input removes the last chip
    const ids = [...selected.value];
    if (ids.length > 0) {
      selected.value.delete(ids[ids.length - 1]);
    }
  }
}

watch(query, (val) => { selectedIndex.value = val ? 0 : -1; });

onMounted(async () => {
  await nextTick();
  inputRef.value?.focus();
});
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('cancel')" @keydown="handleKeydown" @mousemove.once="mouseMoved = true">
    <div class="palette-modal">
      <div class="palette-header">{{ title }}</div>

      <!-- Chips + input area -->
      <div class="input-area" @click="inputRef?.focus()">
        <span
          v-for="item in selectedItems"
          :key="item.id"
          class="chip"
        >
          <span class="chip-text">{{ chipTitle(item) }}</span>
          <button class="chip-remove" @click.stop="removeItem(item.id)">&times;</button>
        </span>
        <input
          ref="inputRef"
          v-model="query"
          v-bind="macOsTextInputAttrs"
          type="text"
          class="inline-input"
          :placeholder="selected.size === 0 ? $t('blockerSelect.searchPlaceholder') : ''"
        />
      </div>

      <!-- Dropdown results -->
      <div v-if="filtered.length > 0" class="command-list">
        <div
          v-for="(item, i) in filtered"
          :key="item.id"
          class="command-item"
          :class="{ highlighted: i === selectedIndex && !isDisabled(item.id), disabled: isDisabled(item.id) }"
          @click="addItem(item.id)"
          @mouseenter="mouseMoved && !isDisabled(item.id) && (selectedIndex = i)"
        >
          <span class="command-label">{{ itemTitle(item) }}</span>
          <span class="command-meta">
            <span v-if="isDisabled(item.id)" class="tag-label">{{ $t('blockerSelect.circularDep') }}</span>
            <span v-else class="tag-label">{{ hasTag(item, 'blocked') ? $t('blockerSelect.statusBlocked') : $t('blockerSelect.statusActive') }}</span>
          </span>
        </div>
      </div>
      <div v-else-if="query" class="command-list">
        <div class="empty">{{ $t('blockerSelect.noMatchingTasks') }}</div>
      </div>

      <div class="palette-footer">
        <span class="hint">
          <template v-if="selected.size === 0">{{ $t('blockerSelect.hintEmpty') }}</template>
          <template v-else>{{ $t('blockerSelect.hintSelected', { count: selected.size }) }}</template>
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
  padding-top: 15vh;
}
.palette-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 550px;
  max-width: 90vw;
  overflow: hidden;
}
.palette-header {
  padding: 10px 14px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--kn-text-muted);
}
.input-area {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 14px;
  background: var(--kn-bg-input);
  border-bottom: 1px solid var(--kn-border-default);
  cursor: text;
  min-height: 38px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--kn-accent);
  color: var(--kn-text-inverse);
  border-radius: 4px;
  padding: 2px 6px 2px 8px;
  font-size: 12px;
  white-space: nowrap;
  max-width: 200px;
}
.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-remove {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 2px;
}
.chip-remove:hover {
  color: var(--kn-text-inverse);
  background: rgba(255, 255, 255, 0.15);
}
.inline-input {
  flex: 1;
  min-width: 80px;
  background: none;
  border: none;
  color: var(--kn-text-primary);
  font-size: 14px;
  outline: none;
  padding: 2px 0;
}
.command-list {
  max-height: 300px;
  overflow-y: auto;
}
.command-item {
  padding: 8px 14px;
  font-size: 13px;
  color: var(--kn-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
.command-item.highlighted {
  background: var(--kn-accent);
  color: var(--kn-text-inverse);
}
.command-item:hover {
  background: var(--kn-bg-hover);
}
.command-item.highlighted:hover {
  background: var(--kn-accent);
}
.command-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.command-item.disabled:hover {
  background: transparent;
}
.command-label {
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-label {
  font-size: 11px;
  color: var(--kn-text-muted);
}
.command-item.highlighted .tag-label {
  color: var(--kn-text-secondary);
}
.palette-footer {
  padding: 8px 14px;
  border-top: 1px solid var(--kn-border-default);
}
.hint {
  font-size: 11px;
  color: var(--kn-text-muted);
}
.empty {
  padding: 16px;
  color: var(--kn-text-muted);
  text-align: center;
  font-size: 13px;
}
</style>
