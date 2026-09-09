<script setup lang="ts">
import { ref, onMounted, onActivated, onDeactivated, nextTick, watch } from "vue";
import TerminalView from "./TerminalView.vue";
import { setContext, resetContext } from "../composables/useShortcutContext";
import {
  useEmbeddableView,
  type EmbeddableViewProps,
} from "../composables/useEmbeddableView";
import { useKannaStore } from "../stores/kanna";

const props = defineProps<EmbeddableViewProps & {
  sessionId: string;
  cwd: string;
  fallbackCwd?: string | null;
  portEnv?: string | null;
  maximized?: boolean;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const termRef = ref<InstanceType<typeof TerminalView> | null>(null);
const store = useKannaStore();

const { zIndex, bringToFront, overlayClass, overlayStyle, dismissOnScrimClick, isForeground } =
  useEmbeddableView(props, { context: "shell" });
if (!props.embedded) {
  // KeepAlive: onUnmounted won't fire on hide, so manage context on activate/deactivate too
  onActivated(() => setContext("shell"));
  onDeactivated(() => resetContext());
}
defineExpose({ zIndex, bringToFront });

onMounted(async () => {
  if (!isForeground()) return;
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
    :class="[{ maximized }, overlayClass]"
    :style="overlayStyle"
    @click.self="dismissOnScrimClick(() => emit('close'))"
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
