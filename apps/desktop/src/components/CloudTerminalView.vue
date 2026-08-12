<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  createConfiguredDesktopRelayTerminalClient,
  type DesktopRelayTerminalClient,
  type DesktopRelayTerminalSubscription,
} from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";
import { getTerminalTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import { registerE2ETerminalBuffer } from "../e2eTerminalBuffers";
import { isShiftEnter, SHIFT_ENTER_CSI_U } from "../composables/terminalKeyboard";

const props = withDefaults(defineProps<{
  active?: boolean;
  ownerDesktopId: string;
  ownerTaskId: string;
  transport?: "cloud" | "lan";
}>(), {
  active: true,
});

const containerRef = ref<HTMLElement | null>(null);
const status = ref<"connecting" | "live" | "closed" | "error">("connecting");
const errorMessage = ref<string | null>(null);
const { effectiveCodeTheme } = useThemeRuntime();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let relayClient: DesktopRelayTerminalClient | null = null;
let subscription: DesktopRelayTerminalSubscription | null = null;
let unregisterE2ETerminalBuffer: (() => void) | null = null;
let focusRafId = 0;

function writeRemoteTerminalError(message: string) {
  status.value = "error";
  errorMessage.value = message;
  terminal?.write(`\r\n[Remote terminal error: ${message}]\r\n`);
}

function fitAndResizeRemote() {
  if (!props.active) return;
  fitAddon?.fit();
  if (!terminal || !relayClient || status.value !== "live") return;
  void relayClient.resize({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch((error) => {
    console.debug("[cloud-terminal] failed to resize remote terminal:", error);
  });
}

async function focusWhenActive() {
  if (!props.active || !terminal) return;
  await nextTick();
  if (focusRafId) cancelAnimationFrame(focusRafId);
  focusRafId = requestAnimationFrame(() => {
    focusRafId = 0;
    if (!props.active || !terminal || document.querySelector(".modal-overlay")) return;
    terminal.focus();
  });
}

async function start() {
  stopSubscription();
  status.value = "connecting";
  errorMessage.value = null;
  terminal?.reset();
  terminal?.write("Connecting to remote terminal...\r\n");

  try {
    relayClient = props.transport === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (!relayClient) {
      throw new Error(props.transport === "lan" ? "LAN terminal is unavailable." : "Cloud transport is not configured for this desktop.");
    }
    subscription = relayClient.observeTerminal({
      desktopId: props.ownerDesktopId,
      taskId: props.ownerTaskId,
      listener(event) {
        if (event.taskId !== props.ownerTaskId) return;
        if (event.type === "ready") {
          status.value = "live";
          fitAndResizeRemote();
          return;
        }
        if (event.type === "output") {
          status.value = "live";
          terminal?.write(event.text);
          return;
        }
        if (event.type === "exit") {
          status.value = "closed";
          terminal?.write(`\r\n[Remote process exited with code ${event.code}]\r\n`);
          return;
        }
        writeRemoteTerminalError(event.message);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote terminal failed.";
    writeRemoteTerminalError(message);
  }
}

function stopSubscription() {
  subscription?.close();
  subscription = null;
  relayClient?.close();
  relayClient = null;
}

function registerTerminalBufferForE2E() {
  unregisterE2ETerminalBuffer?.();
  unregisterE2ETerminalBuffer = terminal
    ? registerE2ETerminalBuffer(props.ownerTaskId, terminal)
    : null;
}

function sendRemoteInput(data: string) {
  const client = relayClient;
  if (!client || status.value !== "live") return;
  void client.sendInput({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    data,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to send remote input.";
    writeRemoteTerminalError(message);
  });
}

onMounted(() => {
  terminal = new Terminal({
    allowProposedApi: true,
    convertEol: true,
    cursorBlink: true,
    disableStdin: false,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    theme: getTerminalTheme(effectiveCodeTheme.value),
  });
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (isShiftEnter(event)) {
      event.preventDefault();
      sendRemoteInput(SHIFT_ENTER_CSI_U);
      return false;
    }
    if (
      event.type === "keydown"
      && event.metaKey
      && !event.altKey
      && !event.ctrlKey
      && event.key.toLowerCase() === "c"
    ) {
      const selection = terminal?.getSelection() ?? "";
      if (!selection) return true;
      void navigator.clipboard.writeText(selection).catch(() => {
        console.error("[cloud-terminal] Failed to copy terminal selection.");
      });
      event.preventDefault();
      return false;
    }
    return true;
  });
  terminal.onData(sendRemoteInput);
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  if (containerRef.value) {
    terminal.open(containerRef.value);
    registerTerminalBufferForE2E();
    fitAndResizeRemote();
    resizeObserver = new ResizeObserver(() => fitAndResizeRemote());
    resizeObserver.observe(containerRef.value);
  }
  void start();
  void focusWhenActive();
});

watch(
  () => [props.ownerDesktopId, props.ownerTaskId, props.transport],
  () => {
    registerTerminalBufferForE2E();
    void start();
  },
);

watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await nextTick();
    if (!terminal || !props.active) return;
    if (status.value === "closed" || status.value === "error") {
      await start();
      if (!props.active) return;
    }
    fitAndResizeRemote();
    await focusWhenActive();
  },
);

watch(effectiveCodeTheme, (theme) => {
  if (terminal) {
    terminal.options.theme = getTerminalTheme(theme);
  }
});

onUnmounted(() => {
  if (focusRafId) cancelAnimationFrame(focusRafId);
  stopSubscription();
  unregisterE2ETerminalBuffer?.();
  unregisterE2ETerminalBuffer = null;
  resizeObserver?.disconnect();
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
});
</script>

<template>
  <div class="cloud-terminal-shell" :data-status="status">
    <div ref="containerRef" class="terminal-container"></div>
    <div v-if="status === 'error' && errorMessage" class="cloud-terminal-status">
      {{ errorMessage }}
    </div>
  </div>
</template>

<style scoped>
.cloud-terminal-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--kn-terminal-bg);
}

.terminal-container {
  width: 100%;
  height: 100%;
}

.cloud-terminal-status {
  position: absolute;
  right: 12px;
  bottom: 12px;
  max-width: min(520px, calc(100% - 24px));
  padding: 8px 10px;
  border: 1px solid var(--kn-danger);
  background: var(--kn-danger-bg);
  color: var(--kn-danger);
  font-size: 12px;
}
</style>
