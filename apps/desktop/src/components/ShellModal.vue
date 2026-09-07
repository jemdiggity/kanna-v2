<script setup lang="ts">
import { ref, onMounted, onActivated, onDeactivated, nextTick, watch } from "vue";
import TerminalView from "./TerminalView.vue";
import { useShortcutContext, setContext, resetContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useKannaStore } from "../stores/kanna";

const props = defineProps<{
  sessionId: string;
  cwd: string;
  fallbackCwd?: string | null;
  portEnv?: string | null;
  maximized?: boolean;
  /**
   * Rendered inline as a main-area tab instead of as an overlay. The tab host
   * owns visibility (and the shortcut context that follows the active tab),
   * so the modal's own context management and z-index stay out of the way.
   */
  embedded?: boolean;
  /** Embedded only: false while another tab is in front of this one. */
  active?: boolean;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const termRef = ref<InstanceType<typeof TerminalView> | null>(null);
const store = useKannaStore();

if (!props.embedded) {
  useShortcutContext("shell");
  // KeepAlive: onUnmounted won't fire on hide, so manage context on activate/deactivate too
  onActivated(() => setContext("shell"));
  onDeactivated(() => resetContext());
}
const { zIndex, bringToFront } = useModalZIndex({ enabled: !props.embedded });
defineExpose({ zIndex, bringToFront });

onMounted(async () => {
  if (props.embedded && props.active === false) return;
  await nextTick();
  termRef.value?.focus();
});

onActivated(async () => {
  await nextTick();
  termRef.value?.fit?.();
  termRef.value?.focus();
});

// An embedded shell is kept mounted while another tab is in front of it, so
// re-focusing and re-fitting happens when it becomes the active tab.
watch(
  () => props.active,
  async (active) => {
    if (!props.embedded || !active) return;
    await nextTick();
    termRef.value?.fit?.();
    termRef.value?.focus();
  },
);

async function spawnShell(sessionId: string, cwd: string, _prompt: string, _cols: number, _rows: number) {
  const isWorktree = !sessionId.startsWith("shell-repo-");
  await store.spawnShellSession(sessionId, cwd, props.portEnv, isWorktree, props.fallbackCwd);
}
</script>

<template>
  <div
    class="modal-overlay"
    :class="{ maximized, embedded }"
    :style="embedded ? undefined : { zIndex }"
    @click.self="embedded || emit('close')"
  >
    <div class="shell-modal">
      <TerminalView
        ref="termRef"
        :key="sessionId"
        :session-id="sessionId"
        :active="active !== false"
        :spawn-options="{ cwd, prompt: '', spawnFn: spawnShell }"
      />
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

.shell-modal {
  background: var(--kn-terminal-bg);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 4px;
}

.modal-overlay.embedded {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 0;
  background: none;
}

.embedded .shell-modal {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  padding: 0;
}

.maximized { background: none; }
.maximized .shell-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
  padding: 0;
}
</style>
