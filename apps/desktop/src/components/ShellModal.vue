<script setup lang="ts">
import { ref, onMounted, onActivated, onDeactivated, nextTick } from "vue";
import TerminalView from "./TerminalView.vue";
import { useShortcutContext, setContext, resetContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useKannaStore } from "../stores/kanna";

const props = defineProps<{
  sessionId: string;
  cwd: string;
  portEnv?: string | null;
  maximized?: boolean;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const termRef = ref<InstanceType<typeof TerminalView> | null>(null);
const store = useKannaStore();

useShortcutContext("shell");
const { zIndex, bringToFront } = useModalZIndex();
defineExpose({ zIndex, bringToFront });

// KeepAlive: onUnmounted won't fire on hide, so manage context on activate/deactivate too
onActivated(() => setContext("shell"));
onDeactivated(() => resetContext());

onMounted(async () => {
  await nextTick();
  termRef.value?.focus();
});

onActivated(async () => {
  await nextTick();
  termRef.value?.fit?.();
  termRef.value?.focus();
});

async function spawnShell(sessionId: string, cwd: string, _prompt: string, _cols: number, _rows: number) {
  const isWorktree = !sessionId.startsWith("shell-repo-");
  await store.spawnShellSession(sessionId, cwd, props.portEnv, isWorktree);
}
</script>

<template>
  <div class="modal-overlay" :class="{ maximized }" :style="{ zIndex }" @click.self="emit('close')">
    <div class="shell-modal">
      <TerminalView
        ref="termRef"
        :key="sessionId"
        :session-id="sessionId"
        :spawn-options="{ cwd, prompt: '', spawnFn: spawnShell }"
      />
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
}

.shell-modal {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 4px;
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
