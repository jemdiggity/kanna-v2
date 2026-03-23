<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import { getShortcutGroups } from "../composables/useKeyboardShortcuts";
import { getContextShortcuts, getContextTitle, type ShortcutContext } from "../composables/useShortcutContext";

const { t } = useI18n();

const props = defineProps<{
  hideOnStartup?: boolean;
  context: ShortcutContext;
  startInFullMode?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:hide-on-startup", value: boolean): void;
  (e: "update:full-mode", value: boolean): void;
}>();

const hideOnStartup = ref(props.hideOnStartup ?? false);
watch(hideOnStartup, (val) => emit("update:hide-on-startup", val));

// Context mode is default on open (relies on v-if destroying/recreating component)
const showFullMode = ref(props.startInFullMode ?? false);
watch(() => props.startInFullMode, (val) => { showFullMode.value = val ?? false; });
const contextTitle = computed(() => getContextTitle(t, props.context));
const contextItems = computed(() => getContextShortcuts(props.context).map(s => ({ ...s, action: t(s.action) })));
const groups = computed(() => getShortcutGroups(t));

function toggleMode() {
  showFullMode.value = !showFullMode.value;
  emit("update:full-mode", showFullMode.value);
}

function splitKeys(display: string): string[] {
  const symbols = ["⌘", "⇧", "⌥", "⌫", "⌃"];
  const parts: string[] = [];
  let rest = display;
  while (rest) {
    const sym = symbols.find((s) => rest.startsWith(s));
    if (sym) {
      parts.push(sym);
      rest = rest.slice(sym.length);
    } else {
      parts.push(rest);
      break;
    }
  }
  return parts;
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal shortcuts-modal">
      <h3>{{ showFullMode ? t('shortcuts.title') : contextTitle }}</h3>

      <!-- Context mode: multi-column grid -->
      <div v-if="!showFullMode" class="context-shortcuts">
        <div v-for="s in contextItems" :key="s.keys" class="shortcut-row">
          <span class="shortcut-action">{{ s.action }}</span>
          <span class="shortcut-keys">
            <kbd v-for="(k, i) in splitKeys(s.keys)" :key="i">{{ k }}</kbd>
          </span>
        </div>
      </div>

      <!-- Full mode: grouped columns -->
      <div v-else class="shortcuts-grid">
        <div v-for="group in groups" :key="group.title" class="shortcut-group">
          <h4>{{ group.title }}</h4>
          <div v-for="s in group.shortcuts" :key="s.keys" class="shortcut-row">
            <span class="shortcut-action">{{ s.action }}</span>
            <span class="shortcut-keys">
              <kbd v-for="(k, i) in splitKeys(s.keys)" :key="i">{{ k }}</kbd>
            </span>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="shortcuts-footer">
        <a class="toggle-link" @click="toggleMode">
          {{ showFullMode ? t('shortcuts.showContext', { context: contextTitle.toLowerCase() }) : t('shortcuts.showAll') }}
          <span class="toggle-hint"><kbd>⇧</kbd><kbd>⌘</kbd><kbd>/</kbd></span>
        </a>
        <label v-if="showFullMode" class="startup-checkbox">
          <input type="checkbox" v-model="hideOnStartup" />
          {{ t('shortcuts.showOnStartup') }}
        </label>
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
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.shortcuts-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 20px 24px;
  width: 900px;
  max-width: 90vw;
}
h3 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
.shortcuts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0 28px;
}
.shortcut-group { margin-bottom: 16px; }
h4 { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; }
.shortcut-row { display: flex; align-items: center; padding: 3px 0; font-size: 13px; }
.shortcut-action { color: #ccc; margin-right: 8px; }
.shortcut-keys { display: flex; gap: 3px; margin-left: auto; }
kbd {
  background: #333;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 2px 7px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px;
  color: #aaa;
  min-width: 20px;
  text-align: center;
  line-height: 1.4;
}
.context-shortcuts {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0 28px;
  margin-bottom: 12px;
}
.shortcuts-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #333;
}
.toggle-link {
  color: #58a6ff;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.toggle-link:hover {
  text-decoration: underline;
}
.toggle-hint {
  margin-left: 6px;
  opacity: 0.5;
}
.toggle-hint kbd {
  font-size: 10px;
  padding: 1px 4px;
  min-width: auto;
}
.startup-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #888;
  cursor: pointer;
}
.startup-checkbox input { cursor: pointer; }
</style>
