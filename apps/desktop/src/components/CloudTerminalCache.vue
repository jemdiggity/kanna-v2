<script lang="ts">
// Each warm entry owns a live remote observer and transport. Keep enough for
// normal task switching without letting background streams grow unbounded.
export const REMOTE_TERMINAL_WARM_CACHE_MAX = 3;
export const REMOTE_TERMINAL_WARM_TIMEOUT_MS = 5 * 60 * 1000;

export interface CloudTerminalCacheEntry {
  key: string;
  ownerDesktopId: string;
  ownerTaskId: string;
  transport?: "cloud" | "lan";
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import CloudTerminalView from "./CloudTerminalView.vue";

const props = defineProps<{
  activeTerminal: CloudTerminalCacheEntry | null;
  discardKey?: string | null;
}>();

interface WarmTerminalEntry extends CloudTerminalCacheEntry {
  lastActivated: number;
}

const entries = ref<WarmTerminalEntry[]>([]);
const activeKey = ref<string | null>(null);
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activationSequence = 0;

function clearExpiry(key: string): void {
  const timer = expiryTimers.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  expiryTimers.delete(key);
}

function removeEntry(key: string): void {
  clearExpiry(key);
  entries.value = entries.value.filter((entry) => entry.key !== key);
}

function scheduleExpiry(key: string): void {
  clearExpiry(key);
  expiryTimers.set(key, setTimeout(() => {
    expiryTimers.delete(key);
    if (activeKey.value !== key) removeEntry(key);
  }, REMOTE_TERMINAL_WARM_TIMEOUT_MS));
}

function evictLeastRecentlyUsed(): void {
  while (entries.value.length > REMOTE_TERMINAL_WARM_CACHE_MAX) {
    const candidate = entries.value
      .filter((entry) => entry.key !== activeKey.value)
      .sort((left, right) => left.lastActivated - right.lastActivated)[0];
    if (!candidate) return;
    removeEntry(candidate.key);
  }
}

function activate(entry: CloudTerminalCacheEntry): void {
  clearExpiry(entry.key);
  const cachedIndex = entries.value.findIndex((candidate) => candidate.key === entry.key);
  const warmEntry: WarmTerminalEntry = {
    ...entry,
    lastActivated: ++activationSequence,
  };
  if (cachedIndex === -1) {
    entries.value.push(warmEntry);
  } else {
    entries.value[cachedIndex] = warmEntry;
  }
  activeKey.value = entry.key;
  evictLeastRecentlyUsed();
}

watch(
  () => props.activeTerminal,
  (next, previous) => {
    if (previous && previous.key !== next?.key) scheduleExpiry(previous.key);
    if (!next) {
      activeKey.value = null;
      return;
    }
    activate(next);
  },
  { immediate: true },
);

watch(
  () => props.discardKey,
  (key) => {
    if (!key) return;
    if (activeKey.value === key) activeKey.value = null;
    removeEntry(key);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
});
</script>

<template>
  <div v-show="activeKey" class="cloud-terminal-cache">
    <div
      v-for="entry in entries"
      v-show="entry.key === activeKey"
      :key="entry.key"
      class="cloud-terminal-cache-entry"
      :data-terminal-cache-key="entry.key"
    >
      <CloudTerminalView
        :active="entry.key === activeKey"
        :owner-desktop-id="entry.ownerDesktopId"
        :owner-task-id="entry.ownerTaskId"
        :transport="entry.transport"
      />
    </div>
  </div>
</template>

<style scoped>
.cloud-terminal-cache {
  display: flex;
  flex: 1;
  min-height: 0;
}

.cloud-terminal-cache-entry {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
