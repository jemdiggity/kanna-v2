<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { shortcuts, type ActionName } from "../composables/useKeyboardShortcuts";

const emit = defineEmits<{
  (e: "close"): void;
  (e: "execute", action: ActionName): void;
}>();

const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

interface Command {
  action: ActionName;
  label: string;
  group: string;
  shortcut: string;
}

const commands = computed<Command[]>(() =>
  shortcuts
    .filter((s) => s.action !== "dismiss" && s.action !== "commandPalette")
    .map((s) => ({ action: s.action, label: s.label, group: s.group, shortcut: s.display }))
);

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return commands.value;
  return commands.value.filter(
    (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
  );
});

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
    const cmd = filtered.value[selectedIndex.value];
    if (cmd) {
      emit("close");
      emit("execute", cmd.action);
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
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="palette-modal">
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="palette-input"
        placeholder="Type a command..."
      />
      <div class="command-list">
        <div
          v-for="(cmd, i) in filtered"
          :key="cmd.action"
          class="command-item"
          :class="{ selected: i === selectedIndex }"
          @click="emit('close'); emit('execute', cmd.action)"
          @mouseenter="selectedIndex = i"
        >
          <span class="command-label">{{ cmd.label }}</span>
          <span class="command-meta">
            <span class="command-group">{{ cmd.group }}</span>
            <kbd class="command-shortcut">{{ cmd.shortcut }}</kbd>
          </span>
        </div>
        <div v-if="filtered.length === 0" class="empty">No commands found</div>
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
  justify-content: space-between;
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
.command-label {
  font-weight: 500;
}
.command-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.command-group {
  font-size: 11px;
  color: #888;
}
.command-item.selected .command-group {
  color: rgba(255, 255, 255, 0.6);
}
.command-shortcut {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: #aaa;
  background: #333;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid #444;
}
.command-item.selected .command-shortcut {
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.25);
}
.empty {
  padding: 16px;
  color: #666;
  text-align: center;
  font-size: 13px;
}
</style>
