<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import { getShortcutGroups } from "../composables/useKeyboardShortcuts";
import { useModalZIndex } from "../composables/useModalZIndex";
import {
  getContextShortcutGroups,
  getContextTitle,
  type ContextShortcutGroup,
  type ShortcutContext,
} from "../composables/useShortcutContext";

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
const { zIndex } = useModalZIndex();
watch(hideOnStartup, (val) => emit("update:hide-on-startup", val));

// Context mode is default on open (relies on v-if destroying/recreating component)
const showFullMode = ref(props.startInFullMode ?? false);
watch(() => props.startInFullMode, (val) => { showFullMode.value = val ?? false; });
const contextTitle = computed(() => getContextTitle(t, props.context));
const groups = computed(() => getShortcutGroups(t));
const contextGroups = computed(() => getContextShortcutGroups(t, props.context));

interface ShortcutDisplayEntrySection {
  kind: "section";
  key: string;
  text: string;
}

interface ShortcutDisplayEntryItem {
  kind: "item";
  key: string;
  action: string;
  keys: string;
}

interface FullModeEntrySection extends ShortcutDisplayEntrySection {
  column: number;
  row: number;
}

interface FullModeEntryItem extends ShortcutDisplayEntryItem {
  column: number;
  row: number;
}

type FullModeEntry = FullModeEntrySection | FullModeEntryItem;

interface ContextModeEntrySection extends ShortcutDisplayEntrySection {
  column: number;
  row: number;
}

interface ContextModeEntryItem extends ShortcutDisplayEntryItem {
  column: number;
  row: number;
}

type ContextModeEntry = ContextModeEntrySection | ContextModeEntryItem;

const fullModeEntries = computed(() => {
  const groupMap = new Map(groups.value.map((group) => [group.key, group]));
  const entriesFor = (groupKey: string, column: number, startRow: number): FullModeEntry[] => {
    const group = groupMap.get(groupKey);
    if (!group) return [];

    return [
      { kind: "section", key: `${group.key}-section`, text: group.title, column, row: startRow },
      ...group.shortcuts.map((shortcut, index) => ({
        kind: "item" as const,
        key: `${group.key}-${shortcut.action}-${shortcut.keys}`,
        action: shortcut.action,
        keys: shortcut.keys,
        column,
        row: startRow + index + 1,
      })),
    ];
  };

  // The first column stacks three groups, so their start rows are computed
  // rather than written down: a hard-coded offset silently collided the moment
  // a group gained a shortcut, printing two entries into one grid cell.
  const stacked: FullModeEntry[] = [];
  let nextRow = 1;
  for (const groupKey of [
    "shortcuts.groupCreateOrganize",
    "shortcuts.groupWorkspace",
    "shortcuts.groupAppHelp",
  ]) {
    const entries = entriesFor(groupKey, 1, nextRow);
    if (entries.length === 0) continue;
    stacked.push(...entries);
    // One blank row separates a group from the next group's heading.
    nextRow += entries.length + 1;
  }

  return [
    ...stacked,
    ...entriesFor("shortcuts.groupMoveAround", 2, 1),
    ...entriesFor("shortcuts.groupOpenInspect", 3, 1),
  ];
});

function getContextColumn(context: ShortcutContext, groupKey: string): 1 | 2 | 3 {
  if (groupKey === "shortcuts.groupSearch") {
    return 1;
  }
  if (context === "graph" && groupKey === "shortcuts.groupNavigation") {
    return 1;
  }
  if ((context === "file" || context === "diff") && groupKey === "shortcuts.groupViews") {
    return 1;
  }
  if (
    groupKey === "shortcuts.groupMoveAround" ||
    groupKey === "shortcuts.groupNavigation" ||
    groupKey.startsWith("context:")
  ) {
    return 2;
  }
  if (
    groupKey === "shortcuts.groupOpenInspect" ||
    groupKey === "shortcuts.groupViews" ||
    groupKey === "shortcuts.groupActions"
  ) {
    return 3;
  }
  return 1;
}

function buildContextModeEntries(groupsForContext: ContextShortcutGroup[]): ContextModeEntry[] {
  const nextRowByColumn: Record<1 | 2 | 3, number> = { 1: 1, 2: 1, 3: 1 };
  const entries: ContextModeEntry[] = [];
  const helpGroup = groupsForContext.find((group) => group.key === "shortcuts.groupAppHelp");
  const nonHelpGroups = groupsForContext.filter((group) => group.key !== "shortcuts.groupAppHelp");

  for (const group of nonHelpGroups) {
    const column = getContextColumn(props.context, group.key);
    const startRow = nextRowByColumn[column];
    entries.push({
      kind: "section",
      key: `${group.key}-section`,
      text: group.title,
      column,
      row: startRow,
    });

    for (const [index, shortcut] of group.shortcuts.entries()) {
      entries.push({
        kind: "item",
        key: `${group.key}-${shortcut.action}-${shortcut.keys}`,
        action: shortcut.action,
        keys: shortcut.keys,
        column,
        row: startRow + index + 1,
      });
    }

    nextRowByColumn[column] = startRow + group.shortcuts.length + 2;
  }

  if (helpGroup) {
    const startRow = Math.max(
      nextRowByColumn[1],
      nextRowByColumn[2],
      nextRowByColumn[3],
    );

    entries.push({
      kind: "section",
      key: `${helpGroup.key}-section`,
      text: helpGroup.title,
      column: 1,
      row: startRow,
    });

    for (const [index, shortcut] of helpGroup.shortcuts.entries()) {
      entries.push({
        kind: "item",
        key: `${helpGroup.key}-${shortcut.action}-${shortcut.keys}`,
        action: shortcut.action,
        keys: shortcut.keys,
        column: 1,
        row: startRow + index + 1,
      });
    }
  }

  return entries;
}

const contextModeEntries = computed<ContextModeEntry[]>(() => {
  return buildContextModeEntries(contextGroups.value);
});

const visibleEntries = computed(() => (
  showFullMode.value ? fullModeEntries.value : contextModeEntries.value
));

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
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('close')">
    <div class="modal shortcuts-modal">
      <h3>{{ showFullMode ? t('shortcuts.title') : contextTitle }}</h3>

      <div class="shortcuts-grid">
        <div
          v-for="entry in visibleEntries"
          :key="entry.key"
          :class="['shortcut-entry', `shortcut-entry--${entry.kind}`]"
          :style="{ gridColumn: `${entry.column}`, gridRow: `${entry.row}` }"
          :data-column="entry.column"
          :data-row="entry.row"
        >
          <template v-if="entry.kind === 'section'">
            <h4>{{ entry.text }}</h4>
          </template>
          <template v-else>
            <span class="shortcut-action">{{ entry.action }}</span>
            <span class="shortcut-keys">
              <kbd v-for="(k, i) in splitKeys(entry.keys)" :key="i">{{ k }}</kbd>
            </span>
          </template>
        </div>
      </div>

      <!-- Footer -->
      <div class="shortcuts-footer">
        <a v-if="props.context !== 'main'" class="toggle-link" @click="toggleMode">
          {{ showFullMode ? t('shortcuts.showContext', { context: contextTitle.toLowerCase() }) : t('shortcuts.showAll') }}
          <span class="toggle-hint"><kbd>⇧</kbd><kbd>⌘</kbd><kbd>/</kbd></span>
        </a>
        <span v-else />
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
  background: var(--kn-overlay-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
}
.shortcuts-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  padding: 20px 24px;
  width: 900px;
  max-width: 90vw;
}
h3 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
.shortcuts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-auto-rows: minmax(28px, auto);
  row-gap: 9px;
  gap: 0 28px;
}
.shortcut-entry {
  min-height: 28px;
  display: flex;
  align-items: center;
}
.shortcut-entry--section h4 {
  color: var(--kn-text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0;
}
.shortcut-entry--item { font-size: 13px; }
.shortcut-action { color: var(--kn-text-secondary); margin-right: 8px; }
.shortcut-keys { display: flex; gap: 3px; margin-left: auto; }
kbd {
  background: var(--kn-bg-hover);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  padding: 2px 7px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px;
  color: var(--kn-text-muted);
  min-width: 20px;
  text-align: center;
  line-height: 1.4;
}
.shortcuts-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--kn-border-default);
}
.toggle-link {
  color: var(--kn-accent);
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
  color: var(--kn-text-muted);
  cursor: pointer;
}
.startup-checkbox input { cursor: pointer; }
</style>
