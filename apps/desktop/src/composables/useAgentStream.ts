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

function mergeSnapshot(existing: JournaledAgentEvent[], snapshot: FrameAgentEvent[]): JournaledAgentEvent[] {
  const bySeq = new Map<number, JournaledAgentEvent>();
  for (const item of existing) bySeq.set(item.seq, item);
  for (const item of snapshot) bySeq.set(Number(item.seq), { seq: Number(item.seq), event: item.event });
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export async function createAgentStream(taskId: string): Promise<UseAgentStreamResult> {
  const events = ref<JournaledAgentEvent[]>([]);
  const connected = ref(false);
  const ended = ref(false);
  const error = ref<string | null>(null);
  let nextSeq = 0;

  const stopConnectionListener = onSharedStreamConnectionChange((value: boolean) => {
    connected.value = value;
  });
  const client = await getSharedStreamClient();

  client.attachAgent(taskId, {
    onSnapshot: (snapshot: FrameAgentEvent[], next: number) => {
      events.value = mergeSnapshot(events.value, snapshot);
      nextSeq = next;
    },
    onEvent: (seq: number, event: AgentEvent) => {
      events.value = mergeSnapshot(events.value, [{ seq, event }]);
      nextSeq = seq + 1;
      if (event.type === "session_ended") ended.value = true;
      if (event.type === "turn_started") ended.value = false;
    },
    onError: (_code: string, message: string) => {
      error.value = message;
    },
  }, nextSeq);

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

export function useAgentStream(taskId: string): UseAgentStreamResult {
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

  void createAgentStream(taskId)
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
