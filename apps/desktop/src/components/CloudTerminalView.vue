<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  createConfiguredDesktopRelayTerminalClient,
  type DesktopRelayTerminalClient,
  type DesktopRelayTerminalSubscription,
} from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";

const props = defineProps<{
  ownerDesktopId: string;
  ownerTaskId: string;
  transport?: "cloud" | "lan";
}>();

const containerRef = ref<HTMLElement | null>(null);
const status = ref<"connecting" | "live" | "closed" | "error">("connecting");
const errorMessage = ref<string | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let relayClient: DesktopRelayTerminalClient | null = null;
let subscription: DesktopRelayTerminalSubscription | null = null;

function writeRemoteTerminalError(message: string) {
  status.value = "error";
  errorMessage.value = message;
  terminal?.write(`\r\n[Remote terminal error: ${message}]\r\n`);
}

function fitAndResizeRemote() {
  fitAddon?.fit();
  if (!terminal || !relayClient || status.value !== "live") return;
  void relayClient.resize({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch(() => undefined);
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
      throw new Error(props.transport === "lan" ? "LAN terminal is unavailable." : "Relay is not configured for this desktop.");
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

onMounted(() => {
  terminal = new Terminal({
    allowProposedApi: true,
    convertEol: true,
    cursorBlink: true,
    disableStdin: false,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    theme: {
      background: "#1a1a1a",
      foreground: "#d4d4d4",
    },
  });
  terminal.onData((data) => {
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
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  if (containerRef.value) {
    terminal.open(containerRef.value);
    fitAndResizeRemote();
    resizeObserver = new ResizeObserver(() => fitAndResizeRemote());
    resizeObserver.observe(containerRef.value);
  }
  void start();
});

watch(
  () => [props.ownerDesktopId, props.ownerTaskId, props.transport],
  () => {
    void start();
  },
);

onUnmounted(() => {
  stopSubscription();
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
  background: #1a1a1a;
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
  border: 1px solid #5c2b2b;
  background: #261818;
  color: #f0b8b8;
  font-size: 12px;
}
</style>
