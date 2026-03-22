<script setup lang="ts">
import { ref, watch, nextTick, type ComponentPublicInstance } from "vue";
import AgentView from "./AgentView.vue";
import TerminalView from "./TerminalView.vue";
import { useKannaStore } from "../stores/kanna";

const props = defineProps<{
  sessionId: string | null;
  agentType?: string;
  worktreePath?: string;
  repoPath?: string;
  prompt?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
}>();

const emit = defineEmits<{
  (e: "agent-completed"): void;
}>();

// Keep PTY terminals alive across switches (VSCode-style show/hide)
interface PtySessionConfig {
  worktreePath?: string;
  prompt?: string;
}
const visitedPtySessions = ref(new Map<string, PtySessionConfig>());
const termRefs = ref<Record<string, ComponentPublicInstance | null>>({});

watch(
  () => [props.sessionId, props.agentType] as const,
  ([newId, agentType], oldVal) => {
    const oldId = oldVal?.[0];
    if (!newId || agentType !== "pty") return;

    // Register new sessions; existing ones keep their original config
    if (!visitedPtySessions.value.has(newId)) {
      visitedPtySessions.value.set(newId, {
        worktreePath: props.worktreePath,
        prompt: props.prompt,
      });
    }

    // Returning to an already-mounted terminal: just fit + focus.
    // xterm.js buffer is preserved via v-show, so no SIGWINCH needed.
    // ResizeObserver handles fit when container becomes visible, but we
    // call fit() explicitly for the case where dimensions haven't changed.
    if (newId !== oldId && visitedPtySessions.value.has(newId)) {
      nextTick(() => {
        const ref = termRefs.value[newId];
        if (ref) {
          (ref as any).fit?.();
          (ref as any).focus?.();
        }
      });
    }
  },
  { immediate: true }
);

function setTermRef(sessionId: string, el: ComponentPublicInstance | null) {
  termRefs.value[sessionId] = el;
}

const store = useKannaStore();
function handleEscape(sid: string) {
  store.handleInterrupt(sid);
}
</script>

<template>
  <div class="terminal-panel">
    <!-- PTY mode: keep all visited terminals alive, show only active one -->
    <TerminalView
      v-for="[sid, config] of visitedPtySessions"
      v-show="sid === sessionId"
      :key="sid"
      :ref="(el: any) => setTermRef(sid, el)"
      :session-id="sid"
      :spawn-options="spawnPtySession && config.worktreePath && config.prompt ? {
        cwd: config.worktreePath,
        prompt: config.prompt,
        spawnFn: spawnPtySession,
      } : undefined"
      :kitty-keyboard="!!(spawnPtySession && config.worktreePath && config.prompt)"
      :on-escape="() => handleEscape(sid)"
    />
    <!-- SDK mode: key by sessionId so switching tasks creates a new view -->
    <AgentView
      v-if="sessionId && agentType !== 'pty'"
      :key="sessionId"
      :session-id="sessionId"
      @completed="emit('agent-completed')"
    />
    <div v-if="!sessionId" class="placeholder">
      No agent session active
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 13px;
}
</style>
