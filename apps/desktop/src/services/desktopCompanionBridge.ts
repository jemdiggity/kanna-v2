import type { CompanionEvent } from "@kanna/agent-protocol";
import type {
  CompanionAssetSnapshot,
  CompanionSnapshot,
} from "@kanna/stream-client";
import {
  buildCompanionDocument,
  parseCompanionBridgeEvent,
  type CompanionDocumentStrings,
} from "@kanna/visual-companion";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { getAppErrorCode, getAppErrorMessage } from "../appError";
import { invoke as tauriInvoke } from "../invoke";
import { listenCurrentWebviewWindow as tauriListen } from "../listen";
import {
  resolveRemoteCompanionLink,
  type RemoteCompanionLinkResolution,
} from "./remoteCompanionLink";
import type {
  DesktopRemoteCompanionEvent,
  DesktopRemoteCompanionSubscription,
  DesktopRemoteTaskClient,
} from "./desktopRemoteTaskClient";
import {
  desktopCompanionRemoteKey,
} from "./desktopCompanionIdentity";
import {
  captureRemoteCompanionOpenForE2E,
  observeRemoteCompanionStatusForE2E,
  recordRemoteCompanionOpenerForE2E,
} from "../e2eRemoteCompanion";
import i18n from "../i18n";

export { desktopCompanionRemoteKey } from "./desktopCompanionIdentity";

const BROWSER_EVENT_NAME = "remote-companion-browser-event";
const DEFAULT_GRACE_PERIOD_MS = 30_000;
const DEFAULT_PENDING_EVENT_TIMEOUT_MS = 30_000;
const RETIRED_BRIDGE_ERROR_CODE = "bridge_not_found";
const RETIRED_BRIDGE_ERROR_MESSAGE = "visual companion bridge not found";
const OPENER_ERROR_CODE = "companion_open_failed";
const OPENER_ERROR_MESSAGE = "The visual companion could not be opened.";
const PROBE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000] as const;
const MAX_IDENTITY_BYTES = 256;
const MAX_STAGED_OBSERVE_RESULTS = 64;
const MAX_BRIDGE_ENTRIES = 16;
const MAX_PENDING_EVENTS_PER_BRIDGE = 64;
const MAX_PENDING_EVENTS_GLOBAL =
  MAX_BRIDGE_ENTRIES * MAX_PENDING_EVENTS_PER_BRIDGE;
let bridgeLeaseCounter = 0;

type BridgeLifecycle = "available" | "reconnecting" | "unavailable" | "error";
type Invoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;
type OpenUrl = (url: string) => Promise<unknown>;

interface CapturedBundle {
  sessionId: string;
  revision: string;
  documentHtml: string;
  lifecyclePageStrings: {
    unavailableTitle: string;
    unavailableDetail: string;
    errorTitle: string;
    errorDetail: string;
  };
  assets: Array<{
    name: string;
    content_type: string;
    digest: string;
    data_b64: string;
  }>;
}

interface BridgeEntry {
  bridgeId: string;
  sessionId: string;
  revision: string;
}

interface PendingBrowserEvent extends BridgeEntry {
  remoteKey: string;
  event: CompanionEvent;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  outcome?: {
    accepted: boolean;
    code?: string;
    message?: string;
  };
}

interface PendingActivation {
  clickedUrl: string;
  generation: number;
  sessionId: string;
  sourceOrigin: string | undefined;
  prepared: {
    result: UpsertResult;
    revision: string;
  } | null;
  started: boolean;
  promise: Promise<OpenRemoteCompanionResult>;
  resolve(result: OpenRemoteCompanionResult): void;
  reject(error: unknown): void;
}

interface ObservationControl {
  generation: number;
  subscription: DesktopRemoteCompanionSubscription;
  activate(remote: RemoteEntry): void;
  abandon(): void;
}

interface RemoteEntry {
  ownerDesktopId: string;
  ownerTaskId: string;
  subscription: DesktopRemoteCompanionSubscription | null;
  transport: DesktopRemoteTaskClient;
  ownershipGeneration: number;
  observationGeneration: number;
  observationControl: ObservationControl | null;
  owned: boolean;
  selected: boolean;
  status: BridgeLifecycle;
  transportConnected: boolean | null;
  snapshot: CompanionSnapshot | null;
  recoverySnapshotPending: boolean;
  bridges: Map<string, BridgeEntry>;
  workerPromise: Promise<void> | null;
  activeBundle: CapturedBundle | null;
  pendingBundle: CapturedBundle | null;
  bundleRetryTimer: ReturnType<typeof setTimeout> | null;
  bundleRetryIndex: number;
  lifecycleDirty: boolean;
  resultKeys: Set<string>;
  lifecycleBarrierKeys: Set<string>;
  activation: PendingActivation | null;
  graceProbeDue: boolean;
  probeTimer: ReturnType<typeof setTimeout> | null;
  probeRetryIndex: number;
  unavailableProbeTimer: ReturnType<typeof setTimeout> | null;
  unavailableProbeRetryIndex: number;
  lifecycleRetryTimer: ReturnType<typeof setTimeout> | null;
  lifecycleRetryIndex: number;
  closing: boolean;
  ownershipClosed: boolean;
}

interface BrowserEventPayload {
  bridgeId: string;
  sessionId: string;
  revision: string;
  event: CompanionEvent;
}

interface UpsertResult {
  bridgeId: string;
  entryUrl: string;
}

export interface AdoptDesktopCompanionRemoteInput {
  remoteKey: string;
  ownerDesktopId: string;
  ownerTaskId: string;
  /** Parent task client transferred to the manager for observation and events. */
  transport: DesktopRemoteTaskClient;
}

export interface DesktopCompanionRemoteOwnership {
  /**
   * Releases the selected component's claim. The manager, not the component,
   * owns the installed subscription: it keeps the current subscription
   * while a Rust bridge may still have a browser and closes it after Rust
   * confirms the bridge's non-renewing deselection grace has expired.
   */
  release(): void;
}

export type OpenRemoteCompanionResult =
  | { kind: "companion"; bridgeId: string }
  | Extract<RemoteCompanionLinkResolution, { kind: "ordinary" | "invalid" }>
  | { kind: "unavailable" };

export interface DesktopCompanionBridgeManager {
  /**
   * Transfers a remote task client to the app-level manager. The manager
   * installs and owns companion observation before returning.
   */
  adoptRemote(input: AdoptDesktopCompanionRemoteInput): DesktopCompanionRemoteOwnership;
  acceptSnapshot(remoteKey: string, snapshot: CompanionSnapshot): void;
  acceptRemoteEvent(remoteKey: string, event: DesktopRemoteCompanionEvent): void;
  setSelected(remoteKey: string, selected: boolean): void;
  openForClickedLink(
    remoteKey: string,
    clickedUrl: string,
  ): Promise<OpenRemoteCompanionResult>;
  /** Opens the currently authenticated companion without requiring a pointer event. */
  openCurrent(remoteKey: string): Promise<OpenRemoteCompanionResult>;
  closeRemote(remoteKey: string): Promise<void>;
  whenIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateDesktopCompanionBridgeManagerOptions {
  invoke?: Invoke;
  listen?: Listen;
  openUrl?: OpenUrl;
  gracePeriodMs?: number;
  pendingEventTimeoutMs?: number;
  leaseGeneration?: string;
  documentStrings?: () => CompanionDocumentStrings;
}

let sharedManager: DesktopCompanionBridgeManager | null = null;
let sharedManagerUnload: (() => void) | null = null;
let sharedManagerDisposal: Promise<void> | null = null;

export function getDesktopCompanionBridgeManager(): DesktopCompanionBridgeManager {
  if (sharedManager) return sharedManager;
  const manager = createDesktopCompanionBridgeManager();
  const unload = () => {
    void disposeDesktopCompanionBridgeManager();
  };
  sharedManager = manager;
  sharedManagerUnload = unload;
  window.addEventListener("beforeunload", unload, { once: true });
  return manager;
}

export async function disposeDesktopCompanionBridgeManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) {
    await sharedManagerDisposal;
    return;
  }
  const unload = sharedManagerUnload;
  sharedManager = null;
  sharedManagerUnload = null;
  if (unload) window.removeEventListener("beforeunload", unload);
  const previous = sharedManagerDisposal;
  const disposal = (async () => {
    await previous;
    await manager.dispose();
  })();
  sharedManagerDisposal = disposal;
  try {
    await disposal;
  } finally {
    if (sharedManagerDisposal === disposal) sharedManagerDisposal = null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    await disposeDesktopCompanionBridgeManager();
  });
}

function cloneSnapshot(snapshot: CompanionSnapshot): CompanionSnapshot {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    documentKind: snapshot.documentKind,
    html: snapshot.html,
    ...(snapshot.sourceOrigin === undefined
      ? {}
      : { sourceOrigin: snapshot.sourceOrigin }),
    assets: snapshot.assets.map((asset) => ({ ...asset })),
  };
}

function isValidSnapshot(snapshot: CompanionSnapshot): boolean {
  return (
    isIdentity(snapshot.sessionId) &&
    isIdentity(snapshot.revision) &&
    (
      snapshot.documentKind === "fragment" ||
      snapshot.documentKind === "full_document"
    ) &&
    typeof snapshot.html === "string" &&
    (
      snapshot.sourceOrigin === undefined ||
      typeof snapshot.sourceOrigin === "string"
    ) &&
    Array.isArray(snapshot.assets) &&
    snapshot.assets.every(
      (asset) =>
        typeof asset === "object" &&
        asset !== null &&
        typeof asset.name === "string" &&
        typeof asset.contentType === "string" &&
        typeof asset.digest === "string" &&
        typeof asset.dataB64 === "string",
    )
  );
}

function appDocumentStrings(): CompanionDocumentStrings {
  const translate = (key: string) =>
    String(i18n.global.t(`visualCompanion.${key}`));
  return {
    connecting: translate("connecting"),
    retry: translate("retry"),
    available: translate("available"),
    reconnecting: translate("reconnecting"),
    unavailable: translate("unavailable"),
    error: translate("error"),
    sending: translate("sending"),
    sent: translate("sent"),
    selectionFailed: translate("selectionFailed"),
    unavailableDetail: translate("unavailableDetail"),
    errorDetail: translate("errorDetail"),
  };
}

function captureBundle(
  snapshot: CompanionSnapshot,
  strings: CompanionDocumentStrings,
): CapturedBundle {
  const copied = cloneSnapshot(snapshot);
  const {
    sessionId,
    revision,
    documentKind,
    html,
  } = copied;
  return {
    sessionId,
    revision,
    documentHtml: buildCompanionDocument({
      documentKind,
      html,
      target: {
        kind: "websocket",
        path: "/ws",
        sessionId,
        revision,
        strings,
      },
    }),
    lifecyclePageStrings: {
      unavailableTitle: strings.unavailable,
      unavailableDetail: strings.unavailableDetail,
      errorTitle: strings.error,
      errorDetail: strings.errorDetail,
    },
    assets: copied.assets.map(toRustAsset),
  };
}

function toRustAsset(asset: CompanionAssetSnapshot): CapturedBundle["assets"][number] {
  return {
    name: asset.name,
    content_type: asset.contentType,
    digest: asset.digest,
    data_b64: asset.dataB64,
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_IDENTITY_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function normalizeBrowserEvent(payload: unknown): BrowserEventPayload | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["bridgeId", "event", "revision", "sessionId"]) ||
    !isIdentity(record.bridgeId) ||
    !isIdentity(record.sessionId) ||
    !isIdentity(record.revision)
  ) {
    return null;
  }
  let event: CompanionEvent | null;
  try {
    event = parseCompanionBridgeEvent(
      JSON.stringify({
        type: "companion-event",
        event: record.event,
      }),
      record.sessionId,
      record.revision,
    );
  } catch {
    return null;
  }
  return event
    ? {
        bridgeId: record.bridgeId,
        sessionId: record.sessionId,
        revision: record.revision,
        event,
      }
    : null;
}

function normalizeUpsertResult(value: unknown): UpsertResult | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["bridgeId", "entryUrl"]) ||
    typeof record.bridgeId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(record.bridgeId) ||
    typeof record.entryUrl !== "string"
  ) {
    return null;
  }
  const match =
    /^http:\/\/[0-9a-f]{32}\.localhost:([0-9]{1,5})\/\?cap=[0-9a-f]{32}$/u
      .exec(record.entryUrl);
  if (!match) return null;
  const port = Number(match[1]);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    String(port) !== match[1]
  ) {
    return null;
  }
  return {
    bridgeId: record.bridgeId,
    entryUrl: record.entryUrl,
  };
}

function isPlausibleUndiscoveredCompanion(url: string): boolean {
  try {
    const parsed = new URL(url);
    const portText =
      /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)(?:[/?#]|$)/iu
        .exec(url)?.[1];
    const port = Number(portText);
    return (
      parsed.protocol === "http:" &&
      portText !== undefined &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
    );
  } catch {
    return false;
  }
}

function isRetiredBridgeError(error: unknown): boolean {
  return (
    getAppErrorCode(error) === RETIRED_BRIDGE_ERROR_CODE ||
    getAppErrorMessage(error) === RETIRED_BRIDGE_ERROR_MESSAGE
  );
}

function openerError(): Error & { code: string } {
  return Object.assign(new Error(OPENER_ERROR_MESSAGE), {
    code: OPENER_ERROR_CODE,
  });
}

function pendingKey(
  remoteKey: string,
  bridgeId: string,
  eventId: string,
): string {
  return `${remoteKey.length}:${remoteKey}${bridgeId}${eventId}`;
}

export function createDesktopCompanionBridgeManager(
  options: CreateDesktopCompanionBridgeManagerOptions = {},
): DesktopCompanionBridgeManager {
  const rawInvoke = options.invoke ?? tauriInvoke;
  const leaseGeneration =
    options.leaseGeneration ??
    (options.invoke ? null : nextBridgeLeaseGeneration());
  const documentStrings = options.documentStrings ?? appDocumentStrings;
  const invoke: Invoke = (command, args) =>
    rawInvoke(
      command,
      leaseGeneration === null
        ? args
        : { ...args, leaseGeneration },
    );
  const listen = options.listen ?? tauriListen;
  const openUrl = options.openUrl ?? tauriOpenUrl;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const pendingEventTimeoutMs =
    Number.isFinite(options.pendingEventTimeoutMs) &&
    (options.pendingEventTimeoutMs ?? 0) > 0
      ? Math.max(1, Math.trunc(options.pendingEventTimeoutMs!))
      : DEFAULT_PENDING_EVENT_TIMEOUT_MS;
  const remotes = new Map<string, RemoteEntry>();
  const closingRemotes = new Map<string, Promise<void>>();
  const closingKeys = new Set<string>();
  const bridgeOwners = new Map<string, string>();
  const pendingEvents = new Map<string, PendingBrowserEvent>();
  let disposed = false;
  let disposalPromise: Promise<void> | null = null;
  let unlisten: (() => void) | null = null;
  let listenerSetupError: unknown = null;

  const listenerReady = listen(BROWSER_EVENT_NAME, (event) => {
    if (disposed) return;
    const browserEvent = normalizeBrowserEvent(event.payload);
    if (!browserEvent) return;
    handleBrowserEvent(browserEvent);
  })
    .then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    })
    .catch((error: unknown) => {
      listenerSetupError = error;
    });

  async function ensureListener(): Promise<void> {
    await listenerReady;
    if (listenerSetupError !== null) throw listenerSetupError;
  }

  function hasActorWork(remote: RemoteEntry): boolean {
    return (
      remote.closing ||
      (remote.activation !== null && !remote.activation.started) ||
      remote.lifecycleDirty ||
      remote.resultKeys.size > 0 ||
      (remote.pendingBundle !== null && remote.bundleRetryTimer === null) ||
      remote.graceProbeDue
    );
  }

  function wakeActor(remoteKey: string, remote: RemoteEntry): Promise<void> {
    if (remote.workerPromise) return remote.workerPromise;
    const worker = Promise.resolve().then(
      () => drainRemote(remoteKey, remote),
    ).finally(() => {
      if (remote.workerPromise === worker) {
        remote.workerPromise = null;
        if (hasActorWork(remote) && !remote.ownershipClosed) {
          wakeActor(remoteKey, remote);
        }
      }
    });
    remote.workerPromise = worker;
    return worker;
  }

  function currentRemote(remoteKey: string): RemoteEntry | null {
    const remote = remotes.get(remoteKey);
    return remote && !remote.closing ? remote : null;
  }

  function closeTransferredOwnership(remote: RemoteEntry) {
    if (remote.ownershipClosed) return;
    remote.ownershipClosed = true;
    remote.observationControl?.abandon();
    remote.observationControl = null;
    try {
      remote.subscription?.close();
    } catch {
      // Continue so the parent transport is always released too.
    }
    try {
      remote.transport.close();
    } catch {
      // Never surface or log transport details during teardown.
    }
  }

  function rejectTransferredOwnership(
    input: AdoptDesktopCompanionRemoteInput,
  ) {
    try {
      input.transport.close();
    } catch {
      // Never surface or log transport details during rejection.
    }
  }

  function clearProbe(remote: RemoteEntry) {
    if (remote.probeTimer !== null) {
      clearTimeout(remote.probeTimer);
      remote.probeTimer = null;
    }
    remote.probeRetryIndex = 0;
  }

  function clearUnavailableProbe(remote: RemoteEntry) {
    if (remote.unavailableProbeTimer !== null) {
      clearTimeout(remote.unavailableProbeTimer);
      remote.unavailableProbeTimer = null;
    }
    remote.unavailableProbeRetryIndex = 0;
  }

  function clearLifecycleRetry(remote: RemoteEntry) {
    if (remote.lifecycleRetryTimer !== null) {
      clearTimeout(remote.lifecycleRetryTimer);
      remote.lifecycleRetryTimer = null;
    }
    remote.lifecycleRetryIndex = 0;
  }

  function clearBundleRetry(remote: RemoteEntry) {
    if (remote.bundleRetryTimer !== null) {
      clearTimeout(remote.bundleRetryTimer);
      remote.bundleRetryTimer = null;
    }
    remote.bundleRetryIndex = 0;
  }

  function scheduleBundleRetry(remoteKey: string, remote: RemoteEntry) {
    if (
      disposed ||
      remote.closing ||
      remote.bundleRetryTimer !== null ||
      remote.pendingBundle === null ||
      currentRemote(remoteKey) !== remote
    ) {
      return;
    }
    const retryIndex = Math.min(
      remote.bundleRetryIndex,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    remote.bundleRetryTimer = setTimeout(() => {
      remote.bundleRetryTimer = null;
      if (
        !disposed &&
        !remote.closing &&
        remote.pendingBundle !== null &&
        currentRemote(remoteKey) === remote
      ) {
        wakeActor(remoteKey, remote);
      }
    }, PROBE_RETRY_DELAYS_MS[retryIndex]);
    remote.bundleRetryIndex = Math.min(
      retryIndex + 1,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    const timer = remote.bundleRetryTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function scheduleLifecycleRetry(remoteKey: string, remote: RemoteEntry) {
    if (
      disposed ||
      remote.closing ||
      remote.lifecycleRetryTimer !== null ||
      currentRemote(remoteKey) !== remote
    ) {
      return;
    }
    const retryIndex = Math.min(
      remote.lifecycleRetryIndex,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    remote.lifecycleRetryTimer = setTimeout(() => {
      remote.lifecycleRetryTimer = null;
      if (
        !disposed &&
        !remote.closing &&
        currentRemote(remoteKey) === remote
      ) {
        // Re-read the authoritative bridge/status/selection state in the
        // actor. The timer never retains the failed payload.
        remote.lifecycleDirty = true;
        wakeActor(remoteKey, remote);
      }
    }, PROBE_RETRY_DELAYS_MS[retryIndex]);
    remote.lifecycleRetryIndex = Math.min(
      retryIndex + 1,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    const timer = remote.lifecycleRetryTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function scheduleProbe(
    remoteKey: string,
    remote: RemoteEntry,
    delayMs: number,
  ) {
    if (
      disposed ||
      remote.selected ||
      remote.probeTimer !== null ||
      currentRemote(remoteKey) !== remote
    ) {
      return;
    }
    remote.probeTimer = setTimeout(() => {
      remote.probeTimer = null;
      if (
        !disposed &&
        !remote.selected &&
        currentRemote(remoteKey) === remote
      ) {
        remote.graceProbeDue = true;
        wakeActor(remoteKey, remote);
      }
    }, delayMs);
    const timer = remote.probeTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function retireReleasedRemote(remoteKey: string, remote: RemoteEntry) {
    if (
      remote.owned ||
      remote.bridges.size > 0 ||
      currentRemote(remoteKey) !== remote
    ) {
      return;
    }
    clearProbe(remote);
    clearUnavailableProbe(remote);
    clearLifecycleRetry(remote);
    clearBundleRetry(remote);
    remote.pendingBundle = null;
    dropPendingEventsForRemote(remoteKey, remote);
    remotes.delete(remoteKey);
    closeTransferredOwnership(remote);
  }

  function retireBridge(
    remoteKey: string,
    remote: RemoteEntry,
    bridgeId: string,
  ) {
    const bridge = remote.bridges.get(bridgeId);
    if (!bridge) return;
    clearLifecycleRetry(remote);
    remote.bridges.delete(bridgeId);
    if (bridgeOwners.get(bridgeId) === remoteKey) {
      bridgeOwners.delete(bridgeId);
    }
    dropPendingEventsForBridge(remote, bridgeId);
  }

  function dropPendingEventsForBridge(
    remote: RemoteEntry,
    bridgeId: string,
  ) {
    for (const [key, pending] of pendingEvents) {
      if (pending.bridgeId === bridgeId) {
        removePendingEvent(remote, key, pending);
      }
    }
  }

  function clearPendingDeadline(pending: PendingBrowserEvent) {
    if (pending.deadlineTimer !== null) {
      clearTimeout(pending.deadlineTimer);
      pending.deadlineTimer = null;
    }
  }

  function removePendingEvent(
    remote: RemoteEntry,
    key: string,
    pending: PendingBrowserEvent,
  ) {
    if (pendingEvents.get(key) !== pending) return false;
    clearPendingDeadline(pending);
    pendingEvents.delete(key);
    remote.resultKeys.delete(key);
    remote.lifecycleBarrierKeys.delete(key);
    return true;
  }

  function dropPendingEventsForRemote(
    remoteKey: string,
    remote: RemoteEntry,
  ) {
    for (const [key, pending] of pendingEvents) {
      if (pending.remoteKey === remoteKey) {
        removePendingEvent(remote, key, pending);
      }
    }
  }

  function hasActivatedSession(remote: RemoteEntry, sessionId: string) {
    return [...remote.bridges.values()].some(
      (bridge) => bridge.sessionId === sessionId,
    );
  }

  function dropSupersededPendingEvents(
    remote: RemoteEntry,
    captured: CapturedBundle,
    bridgeId: string,
  ) {
    for (const [key, pending] of pendingEvents) {
      if (
        pending.bridgeId === bridgeId &&
        (
          pending.sessionId !== captured.sessionId ||
          pending.revision !== captured.revision
        )
      ) {
        removePendingEvent(remote, key, pending);
      }
    }
  }

  function lifecycleForBridge(
    remote: RemoteEntry,
    bridge: BridgeEntry,
    currentStatus: BridgeLifecycle,
  ): BridgeLifecycle {
    return remote.snapshot && bridge.sessionId !== remote.snapshot.sessionId
      ? "unavailable"
      : currentStatus;
  }

  function publishState(
    remoteKey: string,
    remote: RemoteEntry,
    status: BridgeLifecycle,
    _selected: boolean,
  ) {
    observeRemoteCompanionStatusForE2E({
      ownerDesktopId: remote.ownerDesktopId,
      ownerTaskId: remote.ownerTaskId,
      sessionId: remote.snapshot?.sessionId ?? null,
      revision: remote.snapshot?.revision ?? null,
      status,
    });
    remote.lifecycleDirty = true;
    wakeActor(remoteKey, remote);
  }

  async function upsertCaptured(
    remoteKey: string,
    remote: RemoteEntry,
    captured: CapturedBundle,
  ): Promise<UpsertResult> {
    if (disposed || currentRemote(remoteKey) !== remote || remote.closing) {
      throw new Error("visual companion bridge manager is unavailable");
    }
    remote.activeBundle = captured;
    try {
      const rawResult = await invoke<unknown>("upsert_remote_companion_bridge", {
        ownerDesktopId: remote.ownerDesktopId,
        ownerTaskId: remote.ownerTaskId,
        sessionId: captured.sessionId,
        revision: captured.revision,
        documentHtml: captured.documentHtml,
        lifecyclePageStrings: captured.lifecyclePageStrings,
        assets: captured.assets,
      });
      const result = normalizeUpsertResult(rawResult);
      if (!result) {
        const possibleBridgeId =
          typeof rawResult === "object" &&
          rawResult !== null &&
          typeof (rawResult as { bridgeId?: unknown }).bridgeId === "string" &&
          /^[0-9a-f]{32}$/u.test(
            (rawResult as { bridgeId: string }).bridgeId,
          )
            ? (rawResult as { bridgeId: string }).bridgeId
            : null;
        if (possibleBridgeId) {
          await invoke("close_remote_companion_bridge", {
            bridgeId: possibleBridgeId,
          }).catch(() => undefined);
        }
        throw new Error("visual companion bridge returned an invalid response");
      }
      if (currentRemote(remoteKey) !== remote) {
        await invoke("close_remote_companion_bridge", {
          bridgeId: result.bridgeId,
        }).catch(() => undefined);
        throw new Error("visual companion bridge manager is unavailable");
      }
      const entry: BridgeEntry = {
        bridgeId: result.bridgeId,
        sessionId: captured.sessionId,
        revision: captured.revision,
      };
      const replacing = [...remote.bridges.values()].filter(
        (existingBridge) =>
          existingBridge.sessionId === captured.sessionId &&
          existingBridge.bridgeId !== result.bridgeId,
      );
      if (
        !remote.bridges.has(result.bridgeId) &&
        replacing.length === 0 &&
        bridgeOwners.size >= MAX_BRIDGE_ENTRIES
      ) {
        await invoke("close_remote_companion_bridge", {
          bridgeId: result.bridgeId,
        }).catch(() => undefined);
        throw new Error("visual companion bridges exceed their resource limit");
      }
      remote.bridges.set(result.bridgeId, entry);
      bridgeOwners.set(result.bridgeId, remoteKey);
      dropSupersededPendingEvents(remote, captured, result.bridgeId);
      for (const existingBridge of [...remote.bridges.values()]) {
        if (replacing.includes(existingBridge)) {
          retireBridge(remoteKey, remote, existingBridge.bridgeId);
        }
      }
      remote.lifecycleDirty = true;
      return result;
    } finally {
      if (remote.activeBundle === captured) remote.activeBundle = null;
    }
  }

  function failPending(
    pending: PendingBrowserEvent,
    code: string,
    message = "Selection could not be delivered.",
  ) {
    const key = pendingKey(
      pending.remoteKey,
      pending.bridgeId,
      pending.event.event_id,
    );
    const remote = currentRemote(pending.remoteKey);
    if (
      !remote ||
      pendingEvents.get(key) !== pending ||
      pending.outcome
    ) {
      return;
    }
    pending.outcome = { accepted: false, code, message };
    clearPendingDeadline(pending);
    remote.resultKeys.add(key);
    wakeActor(pending.remoteKey, remote);
  }

  function failPendingForRemote(remoteKey: string, code: string) {
    for (const pending of [...pendingEvents.values()]) {
      if (pending.remoteKey === remoteKey) failPending(pending, code);
    }
  }

  function failPendingForLifecycle(
    remoteKey: string,
    remote: RemoteEntry,
    code: string,
    message?: string,
  ) {
    for (const [key, pending] of pendingEvents) {
      if (pending.remoteKey === remoteKey) {
        failPending(
          pending,
          code,
          message ?? "Selection could not be delivered.",
        );
        if (pendingEvents.has(key) && pending.outcome) {
          remote.lifecycleBarrierKeys.add(key);
        }
      }
    }
  }

  function failPendingForReplacedSessions(
    remoteKey: string,
    remote: RemoteEntry,
    currentSessionId: string,
  ) {
    for (const [key, pending] of pendingEvents) {
      if (
        pending.remoteKey === remoteKey &&
        pending.sessionId !== currentSessionId
      ) {
        failPending(pending, "session_replaced");
        if (pendingEvents.has(key) && pending.outcome) {
          remote.lifecycleBarrierKeys.add(key);
        }
      }
    }
  }

  function handleBrowserEvent(browserEvent: BrowserEventPayload) {
    const remoteKey = bridgeOwners.get(browserEvent.bridgeId);
    if (!remoteKey) return;
    const remote = currentRemote(remoteKey);
    const bridge = remote?.bridges.get(browserEvent.bridgeId);
    if (
      !remote ||
      !bridge ||
      bridge.sessionId !== browserEvent.sessionId ||
      bridge.revision !== browserEvent.revision
    ) {
      return;
    }
    const key = pendingKey(
      remoteKey,
      browserEvent.bridgeId,
      browserEvent.event.event_id,
    );
    if (pendingEvents.has(key)) {
      return;
    }
    let bridgePendingCount = 0;
    for (const pending of pendingEvents.values()) {
      if (pending.bridgeId === browserEvent.bridgeId) bridgePendingCount += 1;
    }
    if (
      bridgePendingCount >= MAX_PENDING_EVENTS_PER_BRIDGE ||
      pendingEvents.size >= MAX_PENDING_EVENTS_GLOBAL
    ) {
      return;
    }
    const pending: PendingBrowserEvent = {
      ...bridge,
      remoteKey,
      event: browserEvent.event,
      deadlineTimer: null,
    };
    // Register before invoking transport because a test transport, and some
    // future in-process transports, may synchronously report the result.
    pendingEvents.set(key, pending);
    pending.deadlineTimer = setTimeout(() => {
      pending.deadlineTimer = null;
      if (
        pendingEvents.get(key) === pending &&
        !pending.outcome
      ) {
        failPending(
          pending,
          "event_timeout",
          "Selection confirmation timed out.",
        );
      }
    }, pendingEventTimeoutMs);
    const deadlineTimer =
      pending.deadlineTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      };
    deadlineTimer.unref?.();
    const ingressFailure =
      remote.status !== "available" || !remote.snapshot
        ? "transport_unavailable"
        : remote.snapshot.sessionId !== bridge.sessionId
          ? "session_replaced"
          : remote.snapshot.revision !== bridge.revision
            ? "stale_revision"
            : null;
    if (ingressFailure) {
      failPending(pending, ingressFailure);
      return;
    }
    let accepted = false;
    try {
      accepted = remote.subscription?.sendEvent(
        browserEvent.sessionId,
        browserEvent.revision,
        browserEvent.event,
      ) ?? false;
    } catch {
      accepted = false;
    }
    if (!accepted) failPending(pending, "transport_unavailable");
  }

  function publishEventResult(
    remoteKey: string,
    remote: RemoteEntry,
    event: Extract<DesktopRemoteCompanionEvent, { type: "event_result" }>,
  ) {
    const pending = [...pendingEvents.values()].find(
      (candidate) =>
        candidate.remoteKey === remoteKey &&
        candidate.sessionId === event.result.sessionId &&
        candidate.revision === event.result.revision &&
        candidate.event.event_id === event.result.eventId &&
        !candidate.outcome,
    );
    const key = pending
      ? pendingKey(remoteKey, pending.bridgeId, event.result.eventId)
      : null;
    if (!pending || !key) return;
    pending.outcome = {
      accepted: event.result.accepted,
      code: event.result.code,
      message: event.result.message,
    };
    clearPendingDeadline(pending);
    remote.resultKeys.add(key);
    wakeActor(remoteKey, remote);
  }

  function scheduleUnavailableProbe(remoteKey: string, remote: RemoteEntry) {
    if (
      disposed ||
      remote.closing ||
      remote.unavailableProbeTimer !== null ||
      currentRemote(remoteKey) !== remote
    ) {
      return;
    }
    const retryIndex = Math.min(
      remote.unavailableProbeRetryIndex,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    remote.unavailableProbeTimer = setTimeout(() => {
      remote.unavailableProbeTimer = null;
      if (
        !disposed &&
        !remote.closing &&
        currentRemote(remoteKey) === remote
      ) {
        remote.lifecycleDirty = true;
        wakeActor(remoteKey, remote);
      }
    }, PROBE_RETRY_DELAYS_MS[retryIndex]);
    remote.unavailableProbeRetryIndex = Math.min(
      retryIndex + 1,
      PROBE_RETRY_DELAYS_MS.length - 1,
    );
    const timer = remote.unavailableProbeTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  async function publishLifecycleCycle(
    remoteKey: string,
    remote: RemoteEntry,
    graceProbe: boolean,
  ) {
    let transientFailure = false;
    let retainedUnavailable = false;
    for (const bridge of [...remote.bridges.values()]) {
      if (remote.closing) return;
      const status = lifecycleForBridge(remote, bridge, remote.status);
      const selected = remote.selected;
      const args = {
        bridgeId: bridge.bridgeId,
        status,
        selected,
      };
      try {
        await invoke("set_remote_companion_bridge_state", args);
      } catch (error) {
        if (isRetiredBridgeError(error)) {
          retireBridge(remoteKey, remote, bridge.bridgeId);
        } else {
          transientFailure = true;
        }
        continue;
      }
      if (status !== "available") {
        dropPendingEventsForBridge(remote, bridge.bridgeId);
      }
      if (
        status !== "unavailable" ||
        remote.closing ||
        currentRemote(remoteKey) !== remote ||
        remote.bridges.get(bridge.bridgeId) !== bridge ||
        lifecycleForBridge(remote, bridge, remote.status) !== "unavailable" ||
        remote.selected !== selected
      ) {
        continue;
      }
      try {
        await invoke("set_remote_companion_bridge_state", args);
        retainedUnavailable = true;
      } catch (error) {
        if (isRetiredBridgeError(error)) {
          retireBridge(remoteKey, remote, bridge.bridgeId);
        } else {
          transientFailure = true;
        }
      }
    }
    const hasUnavailable = [...remote.bridges.values()].some(
      (bridge) =>
        lifecycleForBridge(remote, bridge, remote.status) === "unavailable",
    );
    if (transientFailure) {
      clearUnavailableProbe(remote);
    } else if (retainedUnavailable) {
      scheduleUnavailableProbe(remoteKey, remote);
    } else if (!hasUnavailable) {
      clearUnavailableProbe(remote);
    }
    if (transientFailure) {
      scheduleLifecycleRetry(remoteKey, remote);
    } else {
      clearLifecycleRetry(remote);
    }
    if (
      !transientFailure &&
      (graceProbe || !remote.owned) &&
      !remote.selected &&
      remote.bridges.size > 0 &&
      remote.probeTimer === null
    ) {
      const retryIndex = 1;
      remote.probeRetryIndex = Math.min(
        retryIndex + 1,
        PROBE_RETRY_DELAYS_MS.length - 1,
      );
      scheduleProbe(remoteKey, remote, PROBE_RETRY_DELAYS_MS[retryIndex]);
    }
    retireReleasedRemote(remoteKey, remote);
  }

  async function publishOneResult(remote: RemoteEntry) {
    const key = remote.resultKeys.values().next().value as string | undefined;
    if (!key) return;
    remote.resultKeys.delete(key);
    const pending = pendingEvents.get(key);
    if (!pending?.outcome) return;
    try {
      await invoke("set_remote_companion_event_result", {
        bridgeId: pending.bridgeId,
        sessionId: pending.sessionId,
        revision: pending.revision,
        eventId: pending.event.event_id,
        accepted: pending.outcome.accepted,
        code: pending.outcome.code,
        message: pending.outcome.message,
      });
    } catch {
      // A stale result is expected after a browser or bridge closes.
    } finally {
      removePendingEvent(remote, key, pending);
    }
  }

  async function processActivation(
    remoteKey: string,
    remote: RemoteEntry,
    activation: PendingActivation,
  ) {
    activation.started = true;
    const isCurrentActivation = () => {
      const snapshot = remote.snapshot;
      return (
        !remote.closing &&
        currentRemote(remoteKey) === remote &&
        remote.owned &&
        remote.ownershipGeneration === activation.generation &&
        snapshot?.sessionId === activation.sessionId &&
        snapshot.sourceOrigin === activation.sourceOrigin &&
        resolveRemoteCompanionLink({
          clickedUrl: activation.clickedUrl,
          sourceOrigin: snapshot.sourceOrigin,
        }).kind === "companion"
      );
    };
    let openerPending = false;
    let requeued = false;
    if (!isCurrentActivation()) {
      activation.resolve({ kind: "unavailable" });
      if (remote.activation === activation) remote.activation = null;
      return;
    }
    try {
      const snapshot = remote.snapshot;
      if (!snapshot) {
        activation.resolve({ kind: "unavailable" });
        return;
      }
      let result: UpsertResult;
      if (
        activation.prepared &&
        activation.prepared.revision === snapshot.revision
      ) {
        result = activation.prepared.result;
        activation.prepared = null;
      } else {
        activation.prepared = null;
        const captured = captureBundle(snapshot, documentStrings());
        if (remote.pendingBundle?.sessionId === captured.sessionId) {
          remote.pendingBundle = null;
        }
        result = await upsertCaptured(remoteKey, remote, captured);
        if (!isCurrentActivation()) {
          activation.resolve({ kind: "unavailable" });
          return;
        }
        if (remote.pendingBundle?.sessionId === captured.sessionId) {
          remote.pendingBundle = null;
        }
        activation.prepared = {
          result,
          revision: captured.revision,
        };
        activation.started = false;
        requeued = true;
        return;
      }
      if (captureRemoteCompanionOpenForE2E({
        ownerDesktopId: remote.ownerDesktopId,
        ownerTaskId: remote.ownerTaskId,
        sessionId: snapshot.sessionId,
        revision: snapshot.revision,
        status: remote.status,
        entryUrl: result.entryUrl,
      })) {
        activation.resolve({
          kind: "companion",
          bridgeId: result.bridgeId,
        });
        if (remote.activation === activation) remote.activation = null;
        return;
      }
      let opening: Promise<unknown>;
      const openerOwner = {
        ownerDesktopId: remote.ownerDesktopId,
        ownerTaskId: remote.ownerTaskId,
      };
      const openerAttempt = recordRemoteCompanionOpenerForE2E({
        ...openerOwner,
        outcome: "pending",
      });
      try {
        opening = openUrl(result.entryUrl);
      } catch {
        recordRemoteCompanionOpenerForE2E({
          ...openerOwner,
          attempt: openerAttempt,
          outcome: "error",
        });
        activation.reject(openerError());
        return;
      }
      void opening.then(
        () => {
          recordRemoteCompanionOpenerForE2E({
            ...openerOwner,
            attempt: openerAttempt,
            outcome: "success",
          });
          if (
            remote.activation === activation &&
            isCurrentActivation()
          ) {
            activation.resolve({
              kind: "companion",
              bridgeId: result.bridgeId,
            });
          } else {
            activation.resolve({ kind: "unavailable" });
          }
          if (remote.activation === activation) remote.activation = null;
        },
        () => {
          recordRemoteCompanionOpenerForE2E({
            ...openerOwner,
            attempt: openerAttempt,
            outcome: "error",
          });
          if (remote.activation === activation && isCurrentActivation()) {
            activation.reject(openerError());
          } else {
            activation.resolve({ kind: "unavailable" });
          }
          if (remote.activation === activation) remote.activation = null;
        },
      );
      openerPending = true;
    } catch (error) {
      if (remote.closing || currentRemote(remoteKey) !== remote) {
        activation.resolve({ kind: "unavailable" });
      } else {
        retireReleasedRemote(remoteKey, remote);
        activation.reject(error);
      }
    } finally {
      if (!openerPending && !requeued && remote.activation === activation) {
        remote.activation = null;
      }
    }
  }

  async function publishPendingBundle(remoteKey: string, remote: RemoteEntry) {
    const captured = remote.pendingBundle;
    if (!captured) return;
    try {
      await upsertCaptured(remoteKey, remote, captured);
      if (
        currentRemote(remoteKey) !== remote ||
        remote.pendingBundle !== captured ||
        remote.snapshot?.sessionId !== captured.sessionId ||
        remote.snapshot.revision !== captured.revision
      ) {
        return;
      }
      remote.pendingBundle = null;
      clearBundleRetry(remote);
      remote.recoverySnapshotPending = false;
      remote.status =
        remote.transportConnected === false ? "reconnecting" : "available";
      if (remote.status === "available") {
        observeRemoteCompanionStatusForE2E({
          ownerDesktopId: remote.ownerDesktopId,
          ownerTaskId: remote.ownerTaskId,
          sessionId: captured.sessionId,
          revision: captured.revision,
          status: remote.status,
        });
      }
      publishState(remoteKey, remote, remote.status, remote.selected);
    } catch {
      if (
        currentRemote(remoteKey) === remote &&
        remote.pendingBundle === captured &&
        !remote.closing
      ) {
        remote.status = "reconnecting";
        publishState(remoteKey, remote, remote.status, remote.selected);
        scheduleBundleRetry(remoteKey, remote);
      }
    }
  }

  async function performTerminalClose(remoteKey: string, remote: RemoteEntry) {
    clearProbe(remote);
    clearUnavailableProbe(remote);
    clearLifecycleRetry(remote);
    clearBundleRetry(remote);
    remote.pendingBundle = null;
    remote.lifecycleDirty = false;
    remote.graceProbeDue = false;
    if (remote.activation) {
      remote.activation.resolve({ kind: "unavailable" });
      remote.activation = null;
    }
    dropPendingEventsForRemote(remoteKey, remote);
    for (const bridge of [...remote.bridges.values()]) {
      try {
        await invoke("close_remote_companion_bridge", {
          bridgeId: bridge.bridgeId,
        });
      } catch (error) {
        if (!isRetiredBridgeError(error)) {
          // Terminal cleanup remains best-effort.
        }
      }
      retireBridge(remoteKey, remote, bridge.bridgeId);
    }
    closeTransferredOwnership(remote);
  }

  async function drainRemote(remoteKey: string, remote: RemoteEntry) {
    while (!remote.ownershipClosed) {
      if (remote.closing) {
        await performTerminalClose(remoteKey, remote);
        return;
      }
      let serviced = false;
      if (remote.resultKeys.size > 0) {
        serviced = true;
        await publishOneResult(remote);
      }
      if (remote.closing) continue;
      if (
        (remote.lifecycleDirty || remote.graceProbeDue) &&
        remote.lifecycleBarrierKeys.size === 0
      ) {
        serviced = true;
        const graceProbe = remote.graceProbeDue;
        remote.lifecycleDirty = false;
        remote.graceProbeDue = false;
        await publishLifecycleCycle(remoteKey, remote, graceProbe);
      }
      if (remote.closing) continue;
      const activation = remote.activation;
      if (activation && !activation.started) {
        serviced = true;
        await processActivation(remoteKey, remote, activation);
      }
      if (remote.closing) continue;
      if (remote.pendingBundle && remote.bundleRetryTimer === null) {
        serviced = true;
        await publishPendingBundle(remoteKey, remote);
      }
      if (!serviced) return;
    }
  }

  function beginObservation(
    input: AdoptDesktopCompanionRemoteInput,
    generation: number,
  ): ObservationControl {
    let phase: "installing" | "active" | "abandoned" = "installing";
    let installedRemote: RemoteEntry | null = null;
    let sequence = 0;
    let stagedDiscovery: {
      sequence: number;
      event: Extract<
        DesktopRemoteCompanionEvent,
        { type: "snapshot" | "unavailable" }
      >;
    } | null = null;
    let stagedLifecycle: {
      sequence: number;
      event: Extract<
        DesktopRemoteCompanionEvent,
        { type: "connection" | "error" }
      >;
    } | null = null;
    const stagedResults = new Map<
      string,
      Extract<DesktopRemoteCompanionEvent, { type: "event_result" }>
    >();
    const stage = (event: DesktopRemoteCompanionEvent) => {
      sequence += 1;
      if (event.type === "snapshot" || event.type === "unavailable") {
        stagedDiscovery = { sequence, event };
      } else if (event.type === "connection" || event.type === "error") {
        stagedLifecycle = { sequence, event };
      } else {
        if (
          !stagedResults.has(event.result.eventId) &&
          stagedResults.size >= MAX_STAGED_OBSERVE_RESULTS
        ) {
          return;
        }
        stagedResults.set(event.result.eventId, event);
      }
    };
    const abandon = () => {
      phase = "abandoned";
      installedRemote = null;
      stagedDiscovery = null;
      stagedLifecycle = null;
      stagedResults.clear();
    };
    let control: ObservationControl;
    const dispatch = (event: DesktopRemoteCompanionEvent) => {
      const remote = installedRemote;
      if (
        phase !== "active" ||
        !remote ||
        currentRemote(input.remoteKey) !== remote ||
        remote.observationControl !== control ||
        remote.observationGeneration !== generation
      ) {
        return;
      }
      try {
        manager.acceptRemoteEvent(input.remoteKey, event);
      } catch {
        // Transport events are untrusted and never escape observation.
      }
    };
    let subscription: DesktopRemoteCompanionSubscription;
    try {
      subscription = input.transport.observeCompanion({
        desktopId: input.ownerDesktopId,
        taskId: input.ownerTaskId,
        listener: (event) => {
          if (phase === "installing") {
            stage(event);
          } else if (phase === "active") {
            dispatch(event);
          }
        },
      });
    } catch (error) {
      abandon();
      throw error;
    }
    control = {
      generation,
      subscription,
      activate(remote) {
        if (phase !== "installing") return;
        installedRemote = remote;
        phase = "active";
        const stateEvents: Array<{
          sequence: number;
          event: DesktopRemoteCompanionEvent;
        }> = [];
        if (stagedDiscovery) stateEvents.push(stagedDiscovery);
        if (stagedLifecycle) stateEvents.push(stagedLifecycle);
        stateEvents.sort((left, right) => left.sequence - right.sequence);
        stagedDiscovery = null;
        stagedLifecycle = null;
        for (const staged of stateEvents) {
          dispatch(staged.event);
        }
        for (const event of stagedResults.values()) {
          dispatch(event);
        }
        stagedResults.clear();
      },
      abandon,
    };
    return control;
  }

  const manager: DesktopCompanionBridgeManager = {
    adoptRemote(input) {
      const canonicalKey = desktopCompanionRemoteKey(
        input.ownerDesktopId,
        input.ownerTaskId,
      );
      if (input.remoteKey !== canonicalKey) {
        rejectTransferredOwnership(input);
        throw new Error("remote companion owner task is already adopted");
      }
      if (disposed) {
        rejectTransferredOwnership(input);
        return { release() {} };
      }
      const existing = remotes.get(input.remoteKey);
      if (
        existing?.closing ||
        closingKeys.has(input.remoteKey) ||
        closingRemotes.has(input.remoteKey)
      ) {
        rejectTransferredOwnership(input);
        throw new Error("remote companion ownership is closing");
      }
      let remote: RemoteEntry;
      if (existing) {
        if (
          existing.ownerDesktopId !== input.ownerDesktopId ||
          existing.ownerTaskId !== input.ownerTaskId
        ) {
          rejectTransferredOwnership(input);
          throw new Error("remote companion ownership identity changed");
        }
        if (existing.transport === input.transport) {
          existing.ownershipGeneration += 1;
          existing.owned = true;
          existing.selected = true;
          clearProbe(existing);
          clearUnavailableProbe(existing);
          clearLifecycleRetry(existing);
          remote = existing;
          publishState(input.remoteKey, remote, remote.status, true);
        } else {
          let observation: ObservationControl;
          try {
            observation = beginObservation(
              input,
              existing.observationGeneration + 1,
            );
          } catch (error) {
            rejectTransferredOwnership(input);
            throw error;
          }
          const previousSubscription = existing.subscription;
          const previousTransport = existing.transport;
          const previousObservation = existing.observationControl;
          existing.ownerDesktopId = input.ownerDesktopId;
          existing.ownerTaskId = input.ownerTaskId;
          existing.subscription = observation.subscription;
          existing.transport = input.transport;
          existing.observationGeneration = observation.generation;
          existing.observationControl = observation;
          existing.ownershipGeneration += 1;
          existing.owned = true;
          existing.selected = true;
          clearProbe(existing);
          clearUnavailableProbe(existing);
          clearLifecycleRetry(existing);
          clearBundleRetry(existing);
          failPendingForRemote(input.remoteKey, "transport_replaced");
          existing.recoverySnapshotPending = true;
          existing.status = "reconnecting";
          existing.transportConnected = false;
          existing.snapshot = null;
          existing.pendingBundle = null;
          // The gate is revoked before adapter cleanup so even a synchronous
          // or queued callback emitted by close cannot mutate new ownership.
          previousObservation?.abandon();
          try {
            previousSubscription?.close();
          } catch {
            // The replacement still owns the new observation.
          }
          try {
            previousTransport.close();
          } catch {
            // The replacement still owns the new client.
          }
          remote = existing;
          observation.activate(remote);
          publishState(input.remoteKey, remote, remote.status, true);
        }
      } else {
        remote = {
          ownerDesktopId: input.ownerDesktopId,
          ownerTaskId: input.ownerTaskId,
          subscription: null,
          transport: input.transport,
          ownershipGeneration: 1,
          observationGeneration: 0,
          observationControl: null,
          owned: true,
          selected: true,
          status: "reconnecting",
          transportConnected: null,
          snapshot: null,
          recoverySnapshotPending: false,
          bridges: new Map(),
          workerPromise: null,
          activeBundle: null,
          pendingBundle: null,
          bundleRetryTimer: null,
          bundleRetryIndex: 0,
          lifecycleDirty: false,
          resultKeys: new Set(),
          lifecycleBarrierKeys: new Set(),
          activation: null,
          graceProbeDue: false,
          probeTimer: null,
          probeRetryIndex: 0,
          unavailableProbeTimer: null,
          unavailableProbeRetryIndex: 0,
          lifecycleRetryTimer: null,
          lifecycleRetryIndex: 0,
          closing: false,
          ownershipClosed: false,
        };
        remotes.set(input.remoteKey, remote);
        try {
          const observation = beginObservation(input, 1);
          remote.subscription = observation.subscription;
          remote.observationGeneration = observation.generation;
          remote.observationControl = observation;
          observation.activate(remote);
        } catch (error) {
          remotes.delete(input.remoteKey);
          rejectTransferredOwnership(input);
          throw error;
        }
      }
      const generation = remote.ownershipGeneration;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (
            currentRemote(input.remoteKey) !== remote ||
            remote.ownershipGeneration !== generation
          ) {
            return;
          }
          remote.owned = false;
          remote.selected = false;
          publishState(input.remoteKey, remote, remote.status, false);
          if (remote.activeBundle || remote.bridges.size > 0) {
            scheduleProbe(input.remoteKey, remote, gracePeriodMs);
          } else {
            retireReleasedRemote(input.remoteKey, remote);
          }
        },
      };
    },

    acceptSnapshot(remoteKey, nextSnapshot) {
      const remote = currentRemote(remoteKey);
      if (!remote || disposed) return;
      if (!isValidSnapshot(nextSnapshot)) {
        clearBundleRetry(remote);
        remote.status = "error";
        remote.snapshot = null;
        remote.pendingBundle = null;
        failPendingForRemote(remoteKey, "invalid_snapshot");
        publishState(remoteKey, remote, remote.status, remote.selected);
        return;
      }
      const copied = cloneSnapshot(nextSnapshot);
      let pendingBundle: CapturedBundle | null = null;
      if (hasActivatedSession(remote, copied.sessionId)) {
        try {
          pendingBundle = captureBundle(copied, documentStrings());
        } catch {
          remote.status = "error";
          remote.snapshot = null;
          remote.pendingBundle = null;
          failPendingForRemote(remoteKey, "invalid_snapshot");
          publishState(remoteKey, remote, remote.status, remote.selected);
          return;
        }
      }
      clearBundleRetry(remote);
      remote.snapshot = copied;
      remote.recoverySnapshotPending = false;
      clearUnavailableProbe(remote);
      failPendingForReplacedSessions(remoteKey, remote, copied.sessionId);
      if (pendingBundle) {
        remote.status = "reconnecting";
        remote.pendingBundle = pendingBundle;
        wakeActor(remoteKey, remote);
      } else {
        remote.status =
          remote.transportConnected === false ? "reconnecting" : "available";
        if (remote.status === "available") {
          observeRemoteCompanionStatusForE2E({
            ownerDesktopId: remote.ownerDesktopId,
            ownerTaskId: remote.ownerTaskId,
            sessionId: copied.sessionId,
            revision: copied.revision,
            status: remote.status,
          });
        }
        publishState(remoteKey, remote, remote.status, remote.selected);
      }
    },

    acceptRemoteEvent(remoteKey, event) {
      const remote = currentRemote(remoteKey);
      if (!remote || disposed || event.taskId !== remote.ownerTaskId) return;
      switch (event.type) {
        case "snapshot":
          manager.acceptSnapshot(remoteKey, event.snapshot);
          break;
        case "connection":
          remote.transportConnected = event.connected;
          if (!event.connected) {
            // A transport reconnect is not authoritative companion state. Keep
            // the already-served bridge bundle for the open browser, but
            // require the reattached stream to provide a fresh snapshot before
            // returning the bridge to available.
            remote.recoverySnapshotPending = true;
            failPendingForLifecycle(
              remoteKey,
              remote,
              "transport_ambiguous",
              "Selection confirmation was interrupted. Retry is safe.",
            );
          }
          remote.status =
            event.connected &&
            remote.snapshot &&
            !remote.recoverySnapshotPending &&
            remote.pendingBundle === null
            ? "available"
            : "reconnecting";
          publishState(remoteKey, remote, remote.status, remote.selected);
          break;
        case "unavailable":
          clearBundleRetry(remote);
          remote.status = "unavailable";
          remote.snapshot = null;
          remote.pendingBundle = null;
          failPendingForLifecycle(
            remoteKey,
            remote,
            "transport_unavailable",
          );
          publishState(remoteKey, remote, remote.status, remote.selected);
          break;
        case "error":
          remote.status = "error";
          failPendingForLifecycle(
            remoteKey,
            remote,
            "transport_unavailable",
          );
          publishState(remoteKey, remote, remote.status, remote.selected);
          break;
        case "event_result":
          publishEventResult(remoteKey, remote, event);
          break;
      }
    },

    setSelected(remoteKey, selected) {
      const remote = currentRemote(remoteKey);
      if (!remote || disposed || remote.selected === selected) return;
      remote.selected = selected;
      if (selected) {
        clearProbe(remote);
      } else if (remote.bridges.size > 0) {
        scheduleProbe(remoteKey, remote, gracePeriodMs);
      }
      publishState(remoteKey, remote, remote.status, selected);
    },

    async openForClickedLink(remoteKey, clickedUrl) {
      if (disposed) return { kind: "unavailable" };
      const remote = currentRemote(remoteKey);
      if (!remote || !remote.owned || disposed) {
        return { kind: "unavailable" };
      }
      if (!remote.snapshot) {
        const undiscoveredResolution = resolveRemoteCompanionLink({
          clickedUrl,
        });
        if (
          undiscoveredResolution.kind === "ordinary" &&
          isPlausibleUndiscoveredCompanion(clickedUrl)
        ) {
          return { kind: "unavailable" };
        }
        return undiscoveredResolution.kind === "companion"
          ? { kind: "unavailable" }
          : undiscoveredResolution;
      }
      const resolution = resolveRemoteCompanionLink({
        clickedUrl,
        sourceOrigin: remote.snapshot.sourceOrigin,
      });
      if (resolution.kind !== "companion") return resolution;

      const activationGeneration = remote.ownershipGeneration;
      await ensureListener();
      if (
        disposed ||
        currentRemote(remoteKey) !== remote ||
        !remote.owned ||
        remote.ownershipGeneration !== activationGeneration
      ) {
        return { kind: "unavailable" };
      }
      const currentSnapshot = remote.snapshot;
      if (!currentSnapshot) return { kind: "unavailable" };
      const currentResolution = resolveRemoteCompanionLink({
        clickedUrl,
        sourceOrigin: currentSnapshot.sourceOrigin,
      });
      if (currentResolution.kind !== "companion") {
        return { kind: "unavailable" };
      }

      if (remote.activation) {
        return (
          remote.activation.generation === activationGeneration &&
          remote.activation.sessionId === currentSnapshot.sessionId &&
          remote.activation.sourceOrigin === currentSnapshot.sourceOrigin
        )
          ? await remote.activation.promise
          : { kind: "unavailable" };
      }
      let resolveActivation!: (result: OpenRemoteCompanionResult) => void;
      let rejectActivation!: (error: unknown) => void;
      const promise = new Promise<OpenRemoteCompanionResult>((resolve, reject) => {
        resolveActivation = resolve;
        rejectActivation = reject;
      });
      remote.activation = {
        clickedUrl,
        generation: activationGeneration,
        sessionId: currentSnapshot.sessionId,
        sourceOrigin: currentSnapshot.sourceOrigin,
        prepared: null,
        started: false,
        promise,
        resolve: resolveActivation,
        reject: rejectActivation,
      };
      wakeActor(remoteKey, remote);
      return await promise;
    },

    async openCurrent(remoteKey) {
      if (disposed) return { kind: "unavailable" };
      const remote = currentRemote(remoteKey);
      const sourceOrigin = remote?.snapshot?.sourceOrigin;
      if (!remote?.owned || !sourceOrigin) {
        return { kind: "unavailable" };
      }
      return await manager.openForClickedLink(remoteKey, sourceOrigin);
    },

    async closeRemote(remoteKey) {
      const closing = closingRemotes.get(remoteKey);
      if (closing) {
        await closing;
        return;
      }
      const remote = remotes.get(remoteKey);
      if (!remote) return;
      clearProbe(remote);
      clearUnavailableProbe(remote);
      clearLifecycleRetry(remote);
      clearBundleRetry(remote);
      remote.observationControl?.abandon();
      remote.closing = true;
      remote.pendingBundle = null;
      remotes.delete(remoteKey);
      closingKeys.add(remoteKey);
      wakeActor(remoteKey, remote);
      const completed = (async () => {
        while (!remote.ownershipClosed) {
          const worker = remote.workerPromise ?? wakeActor(remoteKey, remote);
          await worker.catch(() => undefined);
        }
      })();
      closingRemotes.set(remoteKey, completed);
      try {
        await completed;
      } finally {
        if (closingRemotes.get(remoteKey) === completed) {
          closingRemotes.delete(remoteKey);
        }
        closingKeys.delete(remoteKey);
      }
    },

    async whenIdle() {
      await ensureListener();
      while (true) {
        const tails = [
          ...[...remotes.values()]
            .map((remote) => remote.workerPromise)
            .filter((worker): worker is Promise<void> => worker !== null),
          ...closingRemotes.values(),
        ];
        await Promise.all(tails);
        const current = [
          ...[...remotes.values()]
            .map((remote) => remote.workerPromise)
            .filter((worker): worker is Promise<void> => worker !== null),
          ...closingRemotes.values(),
        ];
        if (
          tails.length === current.length &&
          tails.every((tail, index) => tail === current[index])
        ) {
          return;
        }
      }
    },

    async dispose() {
      if (disposalPromise) {
        await disposalPromise;
        return;
      }
      disposed = true;
      disposalPromise = (async () => {
        await listenerReady;
        unlisten?.();
        unlisten = null;
        await Promise.all(
          [...remotes.keys()].map((remoteKey) => manager.closeRemote(remoteKey)),
        );
        await Promise.all(closingRemotes.values());
        for (const pending of pendingEvents.values()) {
          clearPendingDeadline(pending);
        }
        pendingEvents.clear();
        if (leaseGeneration !== null) {
          await rawInvoke("close_remote_companion_bridges_for_lease", {
            leaseGeneration,
          });
        }
      })();
      await disposalPromise;
    },
  };

  return manager;
}

function nextBridgeLeaseGeneration(): string {
  bridgeLeaseCounter += 1;
  return `companion-window-${Date.now().toString(36)}-${bridgeLeaseCounter.toString(36)}`;
}
