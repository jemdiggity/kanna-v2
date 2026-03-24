<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { shortcuts, type ActionName } from "../composables/useKeyboardShortcuts";
import { useModalZIndex } from "../composables/useModalZIndex";

const { t } = useI18n();
const { zIndex } = useModalZIndex();

export interface DynamicCommand {
  id: string;
  label: string;
  description?: string;
  execute: () => void;
}

const props = defineProps<{
  extraCommands?: Command[];
  dynamicCommands?: DynamicCommand[];
  usageCounts?: Record<string, number>;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "execute", action: ActionName): void;
  (e: "use", commandId: string): void;
}>();

const query = ref("");
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const mouseMoved = ref(false);

interface Command {
  action: ActionName;
  label: string;
  group: string;
  shortcut: string;
}

interface UnifiedCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  execute: () => void;
}

/** Split a shortcut display string like "⇧⌘P" into individual keys ["⇧", "⌘", "P"] */
function splitKeys(display: string): string[] {
  const modifiers = ["⇧", "⌘", "⌥", "⌃"];
  const keys: string[] = [];
  let rest = display;
  while (rest.length) {
    const mod = modifiers.find((m) => rest.startsWith(m));
    if (mod) {
      keys.push(mod);
      rest = rest.slice(mod.length);
    } else {
      keys.push(rest);
      break;
    }
  }
  return keys;
}

const allCommands = computed<UnifiedCommand[]>(() => {
  // Dynamic commands first (custom tasks)
  const dynamic: UnifiedCommand[] = (props.dynamicCommands || []).map((dc) => ({
    id: dc.id,
    label: dc.label,
    description: dc.description,
    execute: dc.execute,
  }));

  // Static shortcut commands
  const shortcutCommands: UnifiedCommand[] = shortcuts
    .filter((s) => s.action !== "dismiss" && s.action !== "commandPalette")
    .map((s) => ({
      id: `shortcut-${s.action}`,
      label: t(s.labelKey),
      shortcut: s.display,
      execute: () => emit("execute", s.action),
    }));

  // Extra commands (e.g. block task)
  const extra: UnifiedCommand[] = (props.extraCommands || []).map((c) => ({
    id: `extra-${c.action}`,
    label: c.label,
    shortcut: c.shortcut || undefined,
    execute: () => emit("execute", c.action),
  }));

  return [...dynamic, ...shortcutCommands, ...extra];
});

function sortByUsage(commands: UnifiedCommand[]): UnifiedCommand[] {
  const counts = props.usageCounts || {};
  return [...commands].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
}

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return sortByUsage(allCommands.value);
  return sortByUsage(
    allCommands.value.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false)
    )
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
      emit("use", cmd.id);
      emit("close");
      cmd.execute();
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
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('close')" @keydown="handleKeydown" @mousemove.once="mouseMoved = true">
    <div class="palette-modal">
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="palette-input"
        :placeholder="t('commandPalette.placeholder')"
      />
      <div class="command-list">
        <div
          v-for="(cmd, i) in filtered"
          :key="cmd.id"
          class="command-item"
          :class="{ selected: i === selectedIndex }"
          @click="emit('use', cmd.id); emit('close'); cmd.execute()"
          @mouseenter="mouseMoved && (selectedIndex = i)"
        >
          <div class="command-label-group">
            <span class="command-label">{{ cmd.label }}</span>
            <span v-if="cmd.description" class="command-description">{{ cmd.description }}</span>
          </div>
          <span class="command-meta">
            <span v-if="cmd.shortcut" class="command-keys">
              <kbd v-for="key in splitKeys(cmd.shortcut)" :key="key" class="command-key">{{ key }}</kbd>
            </span>
          </span>
        </div>
        <div v-if="filtered.length === 0" class="empty">{{ t('commandPalette.noCommands') }}</div>
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
.command-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.command-label {
  font-weight: 500;
}
.command-description {
  font-size: 11px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.command-item.selected .command-description {
  color: rgba(255, 255, 255, 0.7);
}
.command-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.command-keys {
  display: flex;
  gap: 3px;
}
.command-key {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 11px;
  min-width: 20px;
  text-align: center;
  color: #aaa;
  background: #333;
  padding: 2px 5px;
  border-radius: 4px;
  border: 1px solid #444;
}
.command-item.selected .command-key {
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
