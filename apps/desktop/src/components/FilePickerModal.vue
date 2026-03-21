<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { invoke } from "../invoke";

const props = defineProps<{
  worktreePath: string;
  ideCommand?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", filePath: string): void;
}>();

const query = ref("");
const files = ref<string[]>([]);
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const mouseMoved = ref(false);

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return files.value.slice(0, 100);
  return files.value
    .filter((f) => f.toLowerCase().includes(q))
    .slice(0, 100);
});

async function loadFiles() {
  try {
    files.value = await invoke<string[]>("list_files", {
      path: props.worktreePath,
    });
  } catch (e) {
    console.error("Failed to list files:", e);
  }
}

function selectFile(filePath: string) {
  emit("select", filePath);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
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
    const file = filtered.value[selectedIndex.value];
    if (file) selectFile(file);
  }
}

// Reset selection when query changes
import { watch } from "vue";
watch(query, () => { selectedIndex.value = 0; });

onMounted(async () => {
  await loadFiles();
  await nextTick();
  inputRef.value?.focus();
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown" @mousemove.once="mouseMoved = true">
    <div class="picker-modal">
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="picker-input"
        placeholder="Search files..."
      />
      <div class="file-list">
        <div
          v-for="(file, i) in filtered"
          :key="file"
          class="file-item"
          :class="{ selected: i === selectedIndex }"
          @click="selectFile(file)"
          @mouseenter="mouseMoved && (selectedIndex = i)"
        >
          {{ file }}
        </div>
        <div v-if="filtered.length === 0" class="empty">No files found</div>
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
.picker-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 550px;
  max-width: 90vw;
  overflow: hidden;
}
.picker-input {
  width: 100%;
  padding: 10px 14px;
  background: #1a1a1a;
  border: none;
  border-bottom: 1px solid #333;
  color: #e0e0e0;
  font-size: 14px;
  outline: none;
}
.file-list {
  max-height: 400px;
  overflow-y: auto;
}
.file-item {
  padding: 6px 14px;
  font-size: 13px;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  color: #ccc;
  cursor: pointer;
}
.file-item.selected {
  background: #0066cc;
  color: #fff;
}
.file-item:hover {
  background: #333;
}
.file-item.selected:hover {
  background: #0066cc;
}
.empty {
  padding: 16px;
  color: #666;
  text-align: center;
  font-size: 13px;
}
</style>
