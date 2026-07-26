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
import {
  createRemoteTerminalFileLinkProvider,
  type RemoteTerminalFileLinkProvider,
} from "../composables/remoteTerminalFileLinks";
import { getTerminalTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import { registerE2ETerminalBuffer } from "../e2eTerminalBuffers";

const props = defineProps<{
  ownerDesktopId: string;
  ownerTaskId: string;
  transport?: "cloud" | "lan";
}>();

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
let fileLinkProvider: RemoteTerminalFileLinkProvider | null = null;
const MAX_PENDING_REMOTE_INPUT_CHARS = 64 * 1024;
let startGeneration = 0;

interface RemoteInputQueue {
  client: DesktopRelayTerminalClient;
  desktopId: string;
  taskId: string;
  pending: string;
  inFlight: boolean;
  closed: boolean;
}

let inputQueue: RemoteInputQueue | null = null;

async function readRemoteTaskFile(path: string): Promise<string | null> {
  const client = relayClient;
  if (!client) return null;
  const file = await client.readTaskFile({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    path,
  });
  return file.content;
}

function writeRemoteTerminalError(message: string) {
  status.value = "error";
  errorMessage.value = message;
  terminal?.write(`\r\n[Remote terminal error: ${message}]\r\n`);
}

function closeInputQueue() {
  if (!inputQueue) return;
  inputQueue.closed = true;
  inputQueue.pending = "";
  inputQueue = null;
}

function drainRemoteInput(queue: RemoteInputQueue) {
  if (queue.closed || queue.inFlight || queue.pending.length === 0) return;
  const data = queue.pending;
  queue.pending = "";
  queue.inFlight = true;
  void queue.client.sendInput({
    desktopId: queue.desktopId,
    taskId: queue.taskId,
    data,
  }).catch((error: unknown) => {
    if (inputQueue !== queue || queue.closed) return;
    queue.closed = true;
    queue.pending = "";
    const message = error instanceof Error ? error.message : "Failed to send remote input.";
    writeRemoteTerminalError(message);
  }).finally(() => {
    queue.inFlight = false;
    if (inputQueue === queue && !queue.closed) {
      drainRemoteInput(queue);
    }
  });
}

function enqueueRemoteInput(data: string) {
  const queue = inputQueue;
  if (!queue || queue.closed) return;
  if (queue.pending.length + data.length > MAX_PENDING_REMOTE_INPUT_CHARS) {
    queue.closed = true;
    queue.pending = "";
    writeRemoteTerminalError("Remote terminal input buffer is full.");
    return;
  }
  queue.pending += data;
  drainRemoteInput(queue);
}

function fitAndResizeRemote() {
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

async function start() {
  stopSubscription();
  const generation = startGeneration;
  const desktopId = props.ownerDesktopId;
  const taskId = props.ownerTaskId;
  const transport = props.transport;
  fileLinkProvider?.clearFileCache();
  status.value = "connecting";
  errorMessage.value = null;
  terminal?.reset();
  terminal?.write("Connecting to remote terminal...\r\n");

  let acquiredClient: DesktopRelayTerminalClient | null = null;
  try {
    acquiredClient = transport === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (generation !== startGeneration) {
      acquiredClient?.close();
      return;
    }
    if (!acquiredClient) {
      throw new Error(transport === "lan" ? "LAN terminal is unavailable." : "Cloud transport is not configured for this desktop.");
    }
    const client = acquiredClient;
    relayClient = client;
    inputQueue = {
      client,
      desktopId,
      taskId,
      pending: "",
      inFlight: false,
      closed: false,
    };
    subscription = client.observeTerminal({
      desktopId,
      taskId,
      listener(event) {
        if (
          generation !== startGeneration
          || relayClient !== client
          || event.taskId !== taskId
        ) return;
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
    if (generation !== startGeneration) {
      acquiredClient?.close();
      return;
    }
    closeInputQueue();
    subscription?.close();
    subscription = null;
    if (relayClient === acquiredClient) {
      relayClient = null;
    }
    acquiredClient?.close();
    const message = error instanceof Error ? error.message : "Remote terminal failed.";
    writeRemoteTerminalError(message);
  }
}

function stopSubscription() {
  startGeneration += 1;
  closeInputQueue();
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
  terminal.onData((data) => {
    if (!relayClient || status.value !== "live") return;
    enqueueRemoteInput(data);
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  if (containerRef.value) {
    terminal.open(containerRef.value);
    registerTerminalBufferForE2E();
    fileLinkProvider = createRemoteTerminalFileLinkProvider({
      term: terminal,
      readFile: readRemoteTaskFile,
      getContainer: () => containerRef.value,
    });
    fileLinkProvider.register();
    fitAndResizeRemote();
    resizeObserver = new ResizeObserver(() => fitAndResizeRemote());
    resizeObserver.observe(containerRef.value);
  }
  void start();
});

watch(
  () => [props.ownerDesktopId, props.ownerTaskId, props.transport],
  () => {
    registerTerminalBufferForE2E();
    void start();
  },
);

watch(effectiveCodeTheme, (theme) => {
  if (terminal) {
    terminal.options.theme = getTerminalTheme(theme);
  }
});

onUnmounted(() => {
  stopSubscription();
  unregisterE2ETerminalBuffer?.();
  unregisterE2ETerminalBuffer = null;
  resizeObserver?.disconnect();
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  fileLinkProvider = null;
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
