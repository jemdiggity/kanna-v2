<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface Task {
  id: string;
  repo_id: string;
  prompt: string;
  tags: string;
  activity: string;
  display_name: string | null;
  branch: string | null;
  pr_number: number | null;
  created_at: string;
}

const props = defineProps<{
  task: Task;
}>();

const emit = defineEmits<{
  back: [];
}>();

const termRef = ref<HTMLDivElement>();
const showInput = ref(false);
const inputText = ref("");

let term: Terminal | null = null;
let unlisten: (() => void) | null = null;
let unlistenExit: (() => void) | null = null;

function taskName(task: Task): string {
  if (task.display_name) return task.display_name;
  if (task.prompt) return task.prompt.length > 40 ? task.prompt.slice(0, 40) + "…" : task.prompt;
  return task.id.slice(0, 8);
}

async function sendInput() {
  if (!inputText.value) return;
  const data = Array.from(new TextEncoder().encode(inputText.value + "\r"));
  try {
    await invoke("send_input", { sessionId: props.task.id, data });
  } catch (e) {
    console.error("[terminal] send_input failed:", e);
  }
  inputText.value = "";
}

onMounted(async () => {
  await nextTick();
  if (!termRef.value) return;

  term = new Terminal({
    cols: 120,
    rows: 40,
    fontSize: 13,
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    theme: {
      background: "#0d0d0d",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
    },
    scrollback: 5000,
    convertEol: true,
    disableStdin: true,
  });

  term.open(termRef.value);

  // Listen for terminal output from relay
  unlisten = await listen("terminal_output", (event: { payload: { session_id: string; data_b64: string } }) => {
    const payload = event.payload;
    if (payload.session_id !== props.task.id) return;
    const bytes = Uint8Array.from(atob(payload.data_b64), (c) => c.charCodeAt(0));
    term?.write(bytes);
  });

  unlistenExit = await listen("session_exit", (event: { payload: { session_id: string; code: number } }) => {
    if (event.payload.session_id !== props.task.id) return;
    term?.write(`\r\n\x1b[90m[session exited with code ${event.payload.code}]\x1b[0m\r\n`);
  });

  // Attach to the session (starts observe on kanna-server side)
  try {
    await invoke("attach_session", { sessionId: props.task.id });
  } catch (e) {
    term.write(`\x1b[31m[attach failed: ${e}]\x1b[0m\r\n`);
  }
});

onUnmounted(async () => {
  unlisten?.();
  unlistenExit?.();
  try {
    await invoke("detach_session", { sessionId: props.task.id });
  } catch (e) {
    console.error("[terminal] detach failed:", e);
  }
  term?.dispose();
  term = null;
});
</script>

<template>
  <div class="terminal-view">
    <header class="header">
      <button class="back-btn" @click="emit('back')">‹ Back</button>
      <span class="title">{{ taskName(task) }}</span>
    </header>

    <div class="term-container">
      <div ref="termRef" class="term-element" />
    </div>

    <footer class="footer">
      <template v-if="showInput">
        <form class="input-bar" @submit.prevent="sendInput">
          <input
            v-model="inputText"
            class="input-field"
            placeholder="Send to terminal..."
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button type="submit" class="send-btn">Send</button>
        </form>
      </template>
      <button v-else class="type-btn" @click="showInput = true">Type</button>
    </footer>
  </div>
</template>

<style scoped>
.terminal-view {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  /* Account for safe areas already applied on .app parent */
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #1a1a1a;
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: none;
  color: #5bc0de;
  font-size: 18px;
  padding: 4px 8px;
  cursor: pointer;
}

.title {
  font-size: 14px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-container {
  flex: 1;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  background: #0d0d0d;
}

.term-element {
  /* Let xterm render at its natural size (PTY cols/rows).
     The container scrolls so the user can pan around.
     Pinch-to-zoom is handled natively by iOS scroll views. */
  min-width: 100%;
}

/* Override xterm.js viewport to not constrain width */
.term-element :deep(.xterm) {
  padding: 4px;
}

.footer {
  border-top: 1px solid #1a1a1a;
  padding: 8px 12px;
  flex-shrink: 0;
}

.type-btn {
  background: #1a1a1a;
  border: 1px solid #333;
  color: #888;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 6px;
  width: 100%;
  cursor: pointer;
}

.type-btn:active {
  background: #222;
}

.input-bar {
  display: flex;
  gap: 8px;
}

.input-field {
  flex: 1;
  background: #1a1a1a;
  border: 1px solid #333;
  color: #d4d4d4;
  font-size: 14px;
  font-family: ui-monospace, monospace;
  padding: 8px 12px;
  border-radius: 6px;
  outline: none;
}

.input-field:focus {
  border-color: #5bc0de;
}

.send-btn {
  background: #1a3a4a;
  border: 1px solid #2a5a6a;
  color: #5bc0de;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
}

.send-btn:active {
  background: #2a4a5a;
}
</style>
