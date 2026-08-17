<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "vue-i18n";
import "@xterm/xterm/css/xterm.css";
import {
  createConfiguredDesktopRelayTerminalClient,
} from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";
import {
  createRemoteTerminalFileLinkProvider,
  type RemoteTerminalFileLinkProvider,
} from "../composables/remoteTerminalFileLinks";
import {
  desktopCompanionRemoteKey,
  getDesktopCompanionBridgeManager,
  type DesktopCompanionRemoteOwnership,
} from "../services/desktopCompanionBridge";
import type {
  DesktopRemoteTaskClient,
  DesktopRemoteTerminalSubscription,
} from "../services/desktopRemoteTaskClient";
import { getTerminalTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import { registerE2ETerminalBuffer } from "../e2eTerminalBuffers";
import { useToast } from "../composables/useToast";
import { isShiftEnter, SHIFT_ENTER_CSI_U } from "../composables/terminalKeyboard";
import { createTerminalInputProducerClassifier } from "../composables/terminalInputProducer";

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
const { t } = useI18n();
const toast = useToast();
const companionBridge = getDesktopCompanionBridgeManager();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let inputEventContainer: HTMLElement | null = null;
let relayClient: DesktopRemoteTaskClient | null = null;
let subscription: DesktopRemoteTerminalSubscription | null = null;
let companionOwnership: DesktopCompanionRemoteOwnership | null = null;
let currentRemoteKey: string | null = null;
let currentOwnerDesktopId: string | null = null;
let currentOwnerTaskId: string | null = null;
let unregisterE2ETerminalBuffer: (() => void) | null = null;
let fileLinkProvider: RemoteTerminalFileLinkProvider | null = null;
const MAX_PENDING_REMOTE_INPUT_CHARS = 64 * 1024;
// LAN input is repeated in the authenticated peer envelope. A 4 KiB UTF-8
// chunk stays below the task-transfer runtime's 64 KiB request-frame limit.
const MAX_REMOTE_INPUT_FRAME_BYTES = 4 * 1024;
let lifecycleGeneration = 0;
let unmounted = false;
const inputProducer = createTerminalInputProducerClassifier();
const controlInputEvents = ["mousedown", "mouseup", "mousemove", "wheel", "focus", "blur"];
const draftInputEvents = ["beforeinput", "paste"];

interface RemoteInputQueue {
  client: DesktopRemoteTaskClient;
  desktopId: string;
  taskId: string;
  pending: Array<{ data: string; submissionBoundary: boolean; controlInput: boolean }>;
  pendingChars: number;
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
  inputQueue.pending = [];
  inputQueue.pendingChars = 0;
  inputQueue = null;
}

function drainRemoteInput(queue: RemoteInputQueue) {
  if (queue.closed || queue.inFlight || queue.pending.length === 0) return;
  const pending = queue.pending[0];
  if (!pending) return;
  const [data, remaining] = takeRemoteInputChunk(pending.data);
  const submissionBoundary = pending.submissionBoundary && remaining.length === 0;
  const controlInput = pending.controlInput;
  queue.pendingChars -= data.length;
  if (remaining.length === 0) {
    queue.pending.shift();
  } else {
    pending.data = remaining;
  }
  queue.inFlight = true;
  void queue.client.sendInput({
    desktopId: queue.desktopId,
    taskId: queue.taskId,
    data,
    ...(submissionBoundary ? { submissionBoundary: true } : {}),
    ...(controlInput ? { controlInput: true } : {}),
  }).catch((error: unknown) => {
    if (inputQueue !== queue || queue.closed) return;
    queue.closed = true;
    queue.pending = [];
    queue.pendingChars = 0;
    const message = error instanceof Error ? error.message : "Failed to send remote input.";
    writeRemoteTerminalError(message);
  }).finally(() => {
    queue.inFlight = false;
    if (inputQueue === queue && !queue.closed) {
      drainRemoteInput(queue);
    }
  });
}

function takeRemoteInputChunk(data: string): [string, string] {
  let end = 0;
  let bytes = 0;
  for (const character of data) {
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (bytes + characterBytes > MAX_REMOTE_INPUT_FRAME_BYTES) break;
    bytes += characterBytes;
    end += character.length;
  }
  return [data.slice(0, end), data.slice(end)];
}

function enqueueRemoteInput(data: string, submissionBoundary = false, controlInput = false) {
  const queue = inputQueue;
  if (!queue || queue.closed) return;
  if (queue.pendingChars + data.length > MAX_PENDING_REMOTE_INPUT_CHARS) {
    queue.closed = true;
    queue.pending = [];
    queue.pendingChars = 0;
    writeRemoteTerminalError("Remote terminal input buffer is full.");
    return;
  }
  const last = queue.pending.at(-1);
  if (
    last
    && !last.submissionBoundary
    && !last.controlInput
    && !submissionBoundary
    && !controlInput
  ) {
    last.data += data;
  } else {
    queue.pending.push({ data, submissionBoundary, controlInput });
  }
  queue.pendingChars += data.length;
  drainRemoteInput(queue);
}

function fitAndResizeRemote() {
  if (!props.active) return;
  fitAddon?.fit();
  if (
    !terminal ||
    !relayClient ||
    !currentOwnerDesktopId ||
    !currentOwnerTaskId ||
    status.value !== "live"
  ) {
    return;
  }
  void relayClient.resize({
    desktopId: currentOwnerDesktopId,
    taskId: currentOwnerTaskId,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch((error) => {
    console.debug("[cloud-terminal] failed to resize remote terminal:", error);
  });
}

async function start() {
  stopSubscription();
  const generation = lifecycleGeneration;
  const desktopId = props.ownerDesktopId;
  const taskId = props.ownerTaskId;
  const transport = props.transport;
  const remoteKey = desktopCompanionRemoteKey(desktopId, taskId);
  fileLinkProvider?.clearFileCache();
  status.value = "connecting";
  errorMessage.value = null;
  terminal?.reset();
  terminal?.write("Connecting to remote terminal...\r\n");

  let acquiredClient: DesktopRemoteTaskClient | null = null;
  let adopted = false;
  try {
    acquiredClient = transport === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (unmounted || generation !== lifecycleGeneration) {
      acquiredClient?.close();
      return;
    }
    if (!acquiredClient) {
      throw new Error(transport === "lan" ? "LAN terminal is unavailable." : "Cloud transport is not configured for this desktop.");
    }
    const client = acquiredClient;

    const ownership = companionBridge.adoptRemote({
      remoteKey,
      ownerDesktopId: desktopId,
      ownerTaskId: taskId,
      transport: client,
    });
    adopted = true;
    if (unmounted || generation !== lifecycleGeneration) {
      ownership.release();
      return;
    }

    relayClient = client;
    companionOwnership = ownership;
    currentRemoteKey = remoteKey;
    currentOwnerDesktopId = desktopId;
    currentOwnerTaskId = taskId;
    const queue: RemoteInputQueue = {
      client,
      desktopId,
      taskId,
      pending: [],
      pendingChars: 0,
      inFlight: false,
      closed: false,
    };
    inputQueue = queue;
    subscription = client.observeTerminal({
      desktopId,
      taskId,
      listener(event) {
        if (
          unmounted
          || generation !== lifecycleGeneration
          || relayClient !== client
          || event.taskId !== taskId
        ) return;
        if (event.type === "ready") {
          if (inputQueue === queue && !queue.closed) {
            status.value = "live";
            fitAndResizeRemote();
          }
          return;
        }
        if (event.type === "output") {
          if (inputQueue === queue && !queue.closed) {
            status.value = "live";
          }
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
    if (unmounted || generation !== lifecycleGeneration) {
      if (acquiredClient && !adopted) acquiredClient.close();
      return;
    }
    if (acquiredClient && !adopted) {
      closeInputQueue();
      subscription?.close();
      subscription = null;
      if (relayClient === acquiredClient) {
        relayClient = null;
      }
      acquiredClient.close();
    } else {
      stopSubscription();
    }
    const message = error instanceof Error ? error.message : "Remote terminal failed.";
    writeRemoteTerminalError(message);
  }
}

function stopSubscription() {
  lifecycleGeneration += 1;
  closeInputQueue();
  try {
    subscription?.close();
  } catch {
    // The manager still owns the parent transport.
  }
  subscription = null;
  companionOwnership?.release();
  companionOwnership = null;
  relayClient = null;
  currentRemoteKey = null;
  currentOwnerDesktopId = null;
  currentOwnerTaskId = null;
}

async function activateLink(uri: string): Promise<void> {
  if (unmounted) return;
  const generation = lifecycleGeneration;
  const remoteKey = currentRemoteKey ??
    desktopCompanionRemoteKey(props.ownerDesktopId, props.ownerTaskId);

  await companionBridge.openForClickedLink(remoteKey, uri).then((result) => {
    if (unmounted || generation !== lifecycleGeneration) return;
    if (result.kind === "ordinary") {
      void openUrl(result.url).catch(() => {
        console.error("[cloud-terminal] Failed to open URL.");
      });
      return;
    }
    if (result.kind === "unavailable") {
      toast.info(t("toasts.remoteCompanionStarting"));
    }
  }).catch(() => {
    if (unmounted || generation !== lifecycleGeneration) return;
    toast.error(t("toasts.remoteCompanionOpenFailed"));
  });
}

function handleLinkActivate(event: MouseEvent, uri: string) {
  event.preventDefault();
  void activateLink(uri);
}

async function openCurrentCompanion(): Promise<void> {
  if (unmounted) return;
  const generation = lifecycleGeneration;
  const remoteKey = currentRemoteKey ??
    desktopCompanionRemoteKey(props.ownerDesktopId, props.ownerTaskId);
  await companionBridge.openCurrent(remoteKey).then((result) => {
    if (unmounted || generation !== lifecycleGeneration) return;
    if (result.kind === "unavailable") {
      toast.info(t("toasts.remoteCompanionStarting"));
    }
  }).catch(() => {
    if (unmounted || generation !== lifecycleGeneration) return;
    toast.error(t("toasts.remoteCompanionOpenFailed"));
  });
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
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    inputProducer.handleKeyEvent(event);
    if (isShiftEnter(event)) {
      event.preventDefault();
      enqueueRemoteInput(SHIFT_ENTER_CSI_U);
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
  terminal.onData((data) => {
    if (unmounted || !relayClient || status.value !== "live") return;
    const classification = inputProducer.classifyData();
    enqueueRemoteInput(
      data,
      classification.submissionBoundary,
      classification.controlInput,
    );
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon(handleLinkActivate));
  if (containerRef.value) {
    terminal.open(containerRef.value);
    inputEventContainer = containerRef.value;
    for (const eventName of controlInputEvents) {
      inputEventContainer.addEventListener(eventName, inputProducer.declareControlInput, true);
    }
    for (const eventName of draftInputEvents) {
      inputEventContainer.addEventListener(eventName, inputProducer.declareDraftInput, true);
    }
    inputEventContainer.addEventListener("compositionstart", inputProducer.handleCompositionStart, true);
    inputEventContainer.addEventListener("compositionupdate", inputProducer.handleCompositionUpdate, true);
    inputEventContainer.addEventListener("compositionend", inputProducer.handleCompositionEnd, true);
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

watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await nextTick();
    if (unmounted || !props.active) return;
    fitAndResizeRemote();
  },
);

watch(effectiveCodeTheme, (theme) => {
  if (terminal) {
    terminal.options.theme = getTerminalTheme(theme);
  }
});

onUnmounted(() => {
  unmounted = true;
  lifecycleGeneration += 1;
  stopSubscription();
  unregisterE2ETerminalBuffer?.();
  unregisterE2ETerminalBuffer = null;
  resizeObserver?.disconnect();
  if (inputEventContainer) {
    for (const eventName of controlInputEvents) {
      inputEventContainer.removeEventListener(eventName, inputProducer.declareControlInput, true);
    }
    for (const eventName of draftInputEvents) {
      inputEventContainer.removeEventListener(eventName, inputProducer.declareDraftInput, true);
    }
    inputEventContainer.removeEventListener("compositionstart", inputProducer.handleCompositionStart, true);
    inputEventContainer.removeEventListener("compositionupdate", inputProducer.handleCompositionUpdate, true);
    inputEventContainer.removeEventListener("compositionend", inputProducer.handleCompositionEnd, true);
    inputEventContainer = null;
  }
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  fileLinkProvider = null;
});
</script>

<template>
  <div class="cloud-terminal-shell" :data-status="status">
    <button
      type="button"
      class="open-companion-control"
      :aria-label="t('visualCompanion.open')"
      :title="t('visualCompanion.open')"
      @click="openCurrentCompanion"
      @keydown.enter.prevent="openCurrentCompanion"
      @keydown.space.prevent="openCurrentCompanion"
    >
      {{ t("visualCompanion.open") }}
    </button>
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

.open-companion-control {
  position: absolute;
  z-index: 2;
  top: 8px;
  right: 12px;
  padding: 5px 8px;
  border: 1px solid var(--kn-border-default);
  border-radius: 5px;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.78;
}

.open-companion-control:hover,
.open-companion-control:focus-visible {
  color: var(--kn-text-primary);
  opacity: 1;
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
