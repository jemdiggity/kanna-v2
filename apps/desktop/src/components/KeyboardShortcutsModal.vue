<script setup lang="ts">
import { ref, watch } from "vue";
import { getShortcutGroups } from "../composables/useKeyboardShortcuts";

const props = defineProps<{ hideOnStartup?: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:hide-on-startup", value: boolean): void;
}>();

const hideOnStartup = ref(props.hideOnStartup ?? false);
watch(hideOnStartup, (val) => emit("update:hide-on-startup", val));

const groups = getShortcutGroups();

function splitKeys(display: string): string[] {
  const symbols = ["⌘", "⇧", "⌥", "⌫"];
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
      <h3>Keyboard Shortcuts</h3>
      <div class="shortcuts-grid">
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
      <label class="startup-checkbox">
        <input type="checkbox" v-model="hideOnStartup" />
        Don't show on startup
      </label>
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
  z-index: 1000;
}
.shortcuts-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 20px;
  width: 800px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}
h3 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
.shortcuts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 24px;
}
.shortcut-group { margin-bottom: 16px; }
h4 { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; }
.shortcut-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 13px; }
.shortcut-action { color: #ccc; }
.shortcut-keys { display: flex; gap: 3px; }
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
.startup-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #333;
  font-size: 12px;
  color: #888;
  cursor: pointer;
}
.startup-checkbox input { cursor: pointer; }
</style>
