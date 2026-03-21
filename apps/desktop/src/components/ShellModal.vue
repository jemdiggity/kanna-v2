<script setup lang="ts">
import { ref, onMounted, onActivated, nextTick } from "vue";
import { invoke } from "../invoke";
import TerminalView from "./TerminalView.vue";

const props = defineProps<{
  sessionId: string;
  cwd: string;
  portEnv?: string | null;
  maximized?: boolean;
}>();

const emit = defineEmits<{ (e: "close"): void }>();
const termRef = ref<InstanceType<typeof TerminalView> | null>(null);

onMounted(async () => {
  await nextTick();
  termRef.value?.focus();
});

onActivated(async () => {
  await nextTick();
  termRef.value?.fit?.();
  termRef.value?.focus();
});

async function spawnShell(sessionId: string, cwd: string, _prompt: string, cols: number, rows: number) {
  const env: Record<string, string> = { TERM: "xterm-256color", KANNA_WORKTREE: "1" };
  if (props.portEnv) {
    try { Object.assign(env, JSON.parse(props.portEnv)); } catch {}
  }
  // Use Kanna's zsh init dir so we can set defaults (e.g. emacs keybindings)
  // before the user's .zshrc, which can override them.
  try {
    env.ZDOTDIR = await invoke<string>("ensure_term_init");
  } catch (e) { console.error("[shell] failed to set up term init:", e); }
  await invoke("spawn_session", {
    sessionId,
    cwd,
    executable: "/bin/zsh",
    args: ["--login"],
    env,
    cols,
    rows,
  });
}
</script>

<template>
  <div class="modal-overlay" :class="{ maximized }" @click.self="emit('close')">
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
  z-index: 1000;
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
