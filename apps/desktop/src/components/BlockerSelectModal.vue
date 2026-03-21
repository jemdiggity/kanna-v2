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

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return props.candidates;
  return props.candidates.filter((c) => {
    const name = c.display_name || c.prompt || "";
    return name.toLowerCase().includes(q);
  });
});

function toggleItem(id: string) {
  if (selected.value.has(id)) {
    selected.value.delete(id);
  } else {
    selected.value.add(id);
  }
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
  } else if (e.key === " " && (e.target as HTMLElement)?.tagName !== "INPUT") {
    e.preventDefault();
    const item = filtered.value[selectedIndex.value];
    if (item) toggleItem(item.id);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selected.value.size > 0) {
      emit("confirm", [...selected.value]);
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
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="palette-input"
        placeholder="Search tasks..."
      />
      <div class="command-list">
        <div
          v-for="(item, i) in filtered"
          :key="item.id"
          class="command-item"
          :class="{ selected: i === selectedIndex }"
          @click="toggleItem(item.id)"
          @mouseenter="mouseMoved && (selectedIndex = i)"
        >
          <span class="check">{{ selected.has(item.id) ? '✓' : ' ' }}</span>
          <span class="command-label">{{ itemTitle(item) }}</span>
          <span class="command-meta">
            <span class="stage-label">{{ item.stage === 'in_progress' ? 'In Progress' : 'Blocked' }}</span>
          </span>
        </div>
        <div v-if="filtered.length === 0" class="empty">No matching tasks</div>
      </div>
      <div class="palette-footer">
        <span class="hint">Space to toggle, Enter to confirm ({{ selected.size }} selected)</span>
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
.palette-input {
  width: 100%;
  padding: 10px 14px;
  background: #1a1a1a;
  border: none;
  border-bottom: 1px solid #333;
  color: #e0e0e0;
  font-size: 14px;
  outline: none;
}
.command-list {
  max-height: 400px;
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
.command-item.selected {
  background: #0066cc;
  color: #fff;
}
.command-item:hover {
  background: #333;
}
.command-item.selected:hover {
  background: #0066cc;
}
.check {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  width: 16px;
  text-align: center;
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
.command-item.selected .stage-label {
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
