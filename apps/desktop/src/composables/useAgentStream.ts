import { computed, onUnmounted, ref, shallowRef, type ComputedRef, type Ref } from "vue";
import type { AgentEvent, FrameAgentEvent, PermissionDecision } from "@kanna/agent-protocol";
import { getSharedStreamClient, onSharedStreamConnectionChange } from "./desktopStreamClient";

export interface JournaledAgentEvent {
  seq: number;
  event: AgentEvent;
}

export interface UseAgentStreamResult {
  events: Ref<JournaledAgentEvent[]> | ComputedRef<JournaledAgentEvent[]>;
  connected: Ref<boolean> | ComputedRef<boolean>;
  ready: Ref<boolean> | ComputedRef<boolean>;
  ended: Ref<boolean> | ComputedRef<boolean>;
  error: Ref<string | null> | ComputedRef<string | null>;
  pendingPermissions: Readonly<ComputedRef<Array<Extract<AgentEvent, { type: "permission_request" }>>>>;
  sendInput: (text: string) => void;
  sendPermission: (requestId: string, decision: PermissionDecision) => void;
  interrupt: () => void;
  setModel: (model: string) => void;
  close: () => void;
}

export interface UseAgentStreamOptions {
  recoverSession?: (taskId: string) => Promise<void>;
}

function mergeSnapshot(existing: JournaledAgentEvent[], snapshot: FrameAgentEvent[]): JournaledAgentEvent[] {
  const bySeq = new Map<number, JournaledAgentEvent>();
  for (const item of existing) bySeq.set(item.seq, item);
  for (const item of snapshot) bySeq.set(Number(item.seq), { seq: Number(item.seq), event: item.event });
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function isRecoverableMissingSessionError(code: string, message: string): boolean {
  return (
    code === "no_session" ||
    code === "session_not_found" ||
    message.toLowerCase().includes("session not found")
  );
}

export async function createAgentStream(taskId: string, options: UseAgentStreamOptions = {}): Promise<UseAgentStreamResult> {
  const events = ref<JournaledAgentEvent[]>([]);
  const connected = ref(false);
  const ended = ref(false);
  const error = ref<string | null>(null);
  let nextSeq = 0;
  let recovering = false;

  const stopConnectionListener = onSharedStreamConnectionChange((value: boolean) => {
    connected.value = value;
  });
  const client = await getSharedStreamClient();

  const handlers = {
    onSnapshot: (snapshot: FrameAgentEvent[], next: number) => {
      events.value = mergeSnapshot(events.value, snapshot);
      nextSeq = next;
      error.value = null;
    },
    onEvent: (seq: number, event: AgentEvent) => {
      events.value = mergeSnapshot(events.value, [{ seq, event }]);
      nextSeq = seq + 1;
      error.value = null;
      if (event.type === "session_ended") ended.value = true;
      if (event.type === "turn_started") ended.value = false;
    },
    onError: (code: string, message: string) => {
      if (options.recoverSession && isRecoverableMissingSessionError(code, message)) {
        void recoverAndReattach(message);
        return;
      }
      error.value = message;
    },
  };

  function attach() {
    client.attachAgent(taskId, handlers, nextSeq);
  }

  async function recoverAndReattach(message: string): Promise<void> {
    if (recovering) return;
    recovering = true;
    try {
      await options.recoverSession?.(taskId);
      error.value = null;
      attach();
    } catch (caught: unknown) {
      error.value = caught instanceof Error ? caught.message : `${message}: ${String(caught)}`;
    } finally {
      recovering = false;
    }
  }

  attach();

  const pendingPermissions = computed<Array<Extract<AgentEvent, { type: "permission_request" }>>>(() => {
    const resolved = new Set(
      events.value
        .map((item) => item.event)
        .filter((event): event is Extract<AgentEvent, { type: "permission_resolved" }> => event.type === "permission_resolved")
        .map((event) => event.request_id),
    );
    return events.value
      .map((item) => item.event)
      .filter((event): event is Extract<AgentEvent, { type: "permission_request" }> =>
        event.type === "permission_request" && !resolved.has(event.request_id),
      );
  });

  return {
    events,
    connected,
    ready: computed(() => true),
    ended,
    error,
    pendingPermissions,
    sendInput: (text: string) => client.sendAgentInput(taskId, text),
    sendPermission: (requestId: string, decision: PermissionDecision) => client.sendAgentPermission(taskId, requestId, decision),
    interrupt: () => client.sendAgentInterrupt(taskId),
    setModel: (model: string) => client.sendAgentSetModel(taskId, model),
    close: () => {
      client.detach(taskId, "agent");
      stopConnectionListener();
    },
  };
}

export function useAgentStream(taskId: string, options: UseAgentStreamOptions = {}): UseAgentStreamResult {
  const fallbackEvents = ref<JournaledAgentEvent[]>([]);
  const connected = ref(false);
  const ready = ref(false);
  const ended = ref(false);
  const error = ref<string | null>(null);
  const stream = shallowRef<UseAgentStreamResult | null>(null);
  const pendingOperations: Array<(created: UseAgentStreamResult) => void> = [];
  let closed = false;

  function runSafely(operation: () => void): void {
    try {
      operation();
    } catch (caught: unknown) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function enqueueOrRun(operation: (created: UseAgentStreamResult) => void): void {
    const current = stream.value;
    if (current) {
      runSafely(() => operation(current));
      return;
    }
    if (closed) {
      error.value = "Agent stream is closed";
      return;
    }
    pendingOperations.push(operation);
  }

  void createAgentStream(taskId, options)
    .then((created) => {
      if (closed) {
        created.close();
        return;
      }
      stream.value = created;
      ready.value = true;
      while (pendingOperations.length > 0) {
        const operation = pendingOperations.shift();
        if (operation) runSafely(() => operation(created));
      }
    })
    .catch((caught: unknown) => {
      error.value = caught instanceof Error ? caught.message : String(caught);
    });

  onUnmounted(() => {
    closed = true;
    pendingOperations.length = 0;
    stream.value?.close();
  });

  const pendingPermissions = computed<Array<Extract<AgentEvent, { type: "permission_request" }>>>(() => stream.value?.pendingPermissions.value ?? []);

  return {
    events: computed(() => stream.value?.events.value ?? fallbackEvents.value),
    connected: computed(() => stream.value?.connected.value ?? connected.value),
    ready: computed(() => stream.value?.ready.value ?? ready.value),
    ended: computed(() => stream.value?.ended.value ?? ended.value),
    error: computed(() => stream.value?.error.value ?? error.value),
    pendingPermissions,
    sendInput: (text: string) => enqueueOrRun((created) => created.sendInput(text)),
    sendPermission: (requestId: string, decision: PermissionDecision) =>
      enqueueOrRun((created) => created.sendPermission(requestId, decision)),
    interrupt: () => enqueueOrRun((created) => created.interrupt()),
    setModel: (model: string) => enqueueOrRun((created) => created.setModel(model)),
    close: () => {
      closed = true;
      pendingOperations.length = 0;
      stream.value?.close();
    },
  };
}
