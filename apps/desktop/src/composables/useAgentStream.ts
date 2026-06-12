import { computed, onUnmounted, ref, shallowRef, type ComputedRef, type Ref } from "vue";
import { StreamClient } from "@kanna/stream-client";
import type { AgentEvent, FrameAgentEvent, PermissionDecision } from "@kanna/agent-protocol";
import { invoke } from "../invoke";

export interface JournaledAgentEvent {
  seq: number;
  event: AgentEvent;
}

export interface UseAgentStreamResult {
  events: Ref<JournaledAgentEvent[]> | ComputedRef<JournaledAgentEvent[]>;
  connected: Ref<boolean> | ComputedRef<boolean>;
  ended: Ref<boolean> | ComputedRef<boolean>;
  error: Ref<string | null> | ComputedRef<string | null>;
  pendingPermissions: Readonly<ComputedRef<Array<Extract<AgentEvent, { type: "permission_request" }>>>>;
  sendInput: (text: string) => void;
  sendPermission: (requestId: string, decision: PermissionDecision) => void;
  interrupt: () => void;
  close: () => void;
}

function streamUrlFromPort(port: string | null): string {
  const resolvedPort = port && port.trim().length > 0 ? port.trim() : "48120";
  return `ws://127.0.0.1:${resolvedPort}/v1/stream`;
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

  const port = await invoke<string>("read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }).catch(() => null);
  const client = new StreamClient({
    url: streamUrlFromPort(port),
    onConnectionChange: (value: boolean) => {
      connected.value = value;
    },
  });

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
    ended,
    error,
    pendingPermissions,
    sendInput: (text: string) => client.sendAgentInput(taskId, text),
    sendPermission: (requestId: string, decision: PermissionDecision) => client.sendAgentPermission(taskId, requestId, decision),
    interrupt: () => client.sendAgentInterrupt(taskId),
    close: () => {
      client.detach(taskId, "agent");
      client.close();
    },
  };
}

export function useAgentStream(taskId: string): UseAgentStreamResult {
  const fallbackEvents = ref<JournaledAgentEvent[]>([]);
  const connected = ref(false);
  const ended = ref(false);
  const error = ref<string | null>(null);
  const stream = shallowRef<UseAgentStreamResult | null>(null);

  void createAgentStream(taskId)
    .then((created) => {
      stream.value = created;
    })
    .catch((caught: unknown) => {
      error.value = caught instanceof Error ? caught.message : String(caught);
    });

  onUnmounted(() => {
    stream.value?.close();
  });

  const pendingPermissions = computed<Array<Extract<AgentEvent, { type: "permission_request" }>>>(() => stream.value?.pendingPermissions.value ?? []);

  return {
    events: computed(() => stream.value?.events.value ?? fallbackEvents.value),
    connected: computed(() => stream.value?.connected.value ?? connected.value),
    ended: computed(() => stream.value?.ended.value ?? ended.value),
    error: computed(() => stream.value?.error.value ?? error.value),
    pendingPermissions,
    sendInput: (text: string) => stream.value?.sendInput(text),
    sendPermission: (requestId: string, decision: PermissionDecision) => stream.value?.sendPermission(requestId, decision),
    interrupt: () => stream.value?.interrupt(),
    close: () => stream.value?.close(),
  };
}
