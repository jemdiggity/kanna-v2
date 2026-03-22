<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import type { PipelineItem } from "@kanna/db";

const props = defineProps<{
  candidates: PipelineItem[];
  preselected?: string[];
  title: string;
}>();

const emit = defineEmits<{
  (e: "confirm", selectedIds: string[]): void;
  (e: "cancel"): void;
}>();

const query = ref("");
const selected = ref<Set<string>>(new Set(props.preselected || []));
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const mouseMoved = ref(false);

// Only show candidates that aren't already selected
const filtered = computed(() => {
  const base = props.candidates.filter((c) => !selected.value.has(c.id));
  const q = query.value.toLowerCase();
  if (!q) return base;
  return base.filter((c) => {
    const name = c.display_name || c.prompt || "";
    return name.toLowerCase().includes(q);
  });
});

const selectedItems = computed(() =>
  props.candidates.filter((c) => selected.value.has(c.id))
);

function addItem(id: string) {
  selected.value.add(id);
  query.value = "";
  inputRef.value?.focus();
}

function removeItem(id: string) {
  selected.value.delete(id);
  inputRef.value?.focus();
}

function chipTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || "Untitled";
  return raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
}

function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || "Untitled";
  return raw.length > 60 ? raw.slice(0, 60) + "..." : raw;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault();
    e.stopPropagation();
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1);
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault();
    e.stopPropagation();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (filtered.value.length > 0 && query.value) {
      // If typing a search, Enter adds the highlighted item
      const item = filtered.value[selectedIndex.value];
      if (item) addItem(item.id);
    } else if (selected.value.size > 0) {
      // If not searching, Enter confirms
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

watch(query, () => { selectedIndex.value = 0; });

onMounted(async () => {
  await nextTick();
  inputRef.value?.focus();
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')" @keydown="handleKeydown" @mousemove.once="mouseMoved = true">
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
          type="text"
          class="inline-input"
          :placeholder="selected.size === 0 ? 'Search tasks...' : ''"
        />
      </div>

      <!-- Dropdown results -->
      <div v-if="filtered.length > 0" class="command-list">
        <div
          v-for="(item, i) in filtered"
          :key="item.id"
          class="command-item"
          :class="{ highlighted: i === selectedIndex }"
          @click="addItem(item.id)"
          @mouseenter="mouseMoved && (selectedIndex = i)"
        >
          <span class="command-label">{{ itemTitle(item) }}</span>
          <span class="command-meta">
            <span class="stage-label">{{ item.stage === 'in_progress' ? 'In Progress' : 'Blocked' }}</span>
          </span>
        </div>
      </div>
      <div v-else-if="query" class="command-list">
        <div class="empty">No matching tasks</div>
      </div>

      <div class="palette-footer">
        <span class="hint">
          <template v-if="selected.size === 0">Type to search, Enter to add</template>
          <template v-else>Enter to confirm ({{ selected.size }} selected) · Backspace to remove last</template>
        </span>
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
  padding-top: 15vh;
  z-index: 1000;
}
.palette-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 550px;
  max-width: 90vw;
  overflow: hidden;
}
.palette-header {
  padding: 10px 14px 0;
  font-size: 13px;
  font-weight: 600;
  color: #aaa;
}
.input-area {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 14px;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
  cursor: text;
  min-height: 38px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #0066cc;
  color: #fff;
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
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
}
.inline-input {
  flex: 1;
  min-width: 80px;
  background: none;
  border: none;
  color: #e0e0e0;
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
  color: #ccc;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}
.command-item.highlighted {
  background: #0066cc;
  color: #fff;
}
.command-item:hover {
  background: #333;
}
.command-item.highlighted:hover {
  background: #0066cc;
}
.command-label {
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stage-label {
  font-size: 11px;
  color: #888;
}
.command-item.highlighted .stage-label {
  color: #ccc;
}
.palette-footer {
  padding: 8px 14px;
  border-top: 1px solid #333;
}
.hint {
  font-size: 11px;
  color: #666;
}
.empty {
  padding: 16px;
  color: #666;
  text-align: center;
  font-size: 13px;
}
</style>
