import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { getCurrentBuildIdentity } from "../updates/buildIdentity";

const DIAGNOSTICS_STORAGE_KEY = "kanna.mobile.crash-diagnostics.v1";
const MAX_DIAGNOSTICS = 5;
const MAX_BREADCRUMBS = 20;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 12_000;
const GLOBAL_HANDLER_PERSISTENCE_DEADLINE_MS = 500;
const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_FIELD_PATTERN =
  /authorization|proxy-authorization|(?:access|refresh|id)[_-]?token|token|password|passwd|secret|api[_-]?key|credential|cookie|session/i;

export type MobileCrashDiagnosticKind =
  | "javascript-error"
  | "react-render-error"
  | "webview-load-error"
  | "webview-process-terminated";

export interface MobileCrashContext {
  appState: string;
  connectionMode: string;
  connectionState: string;
  forceCloudEnabled: boolean;
  selectedTaskId: string | null;
  terminalCols: number | null;
  terminalOutputChars: number;
  terminalOutputEpoch: number;
  terminalOutputStart: number;
  terminalRows: number | null;
  terminalStatus: string;
}

export interface MobileCrashBreadcrumb {
  at: string;
  category: "app-state" | "runtime-context";
  message: string;
}

export interface MobileCrashDiagnostic {
  schemaVersion: 1;
  id: string;
  at: string;
  kind: MobileCrashDiagnosticKind;
  fatal: boolean;
  message: string;
  stack?: string;
  componentStack?: string;
  details?: Record<string, string | number | boolean | null>;
  context: MobileCrashContext;
  breadcrumbs: MobileCrashBreadcrumb[];
  build: {
    channel: string;
    environment: string;
    nativeSummary: string;
    runtimeVersion: string;
    source: string;
  };
}

export interface MobileCrashDiagnosticInput {
  kind: MobileCrashDiagnosticKind;
  fatal?: boolean;
  message: string;
  stack?: string;
  componentStack?: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}

export interface MobileCrashDiagnosticCapture {
  diagnostic: MobileCrashDiagnostic;
  persistence: Promise<void>;
  /** Stop record-specific waiting while leaving the record coalesced for storage. */
  releasePersistenceTracking(): void;
}

interface DiagnosticStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  setItem(key: string, value: string): Promise<void>;
}

interface DiagnosticEnvironment {
  now(): Date;
  randomId(): string;
  readBuild(): MobileCrashDiagnostic["build"];
}

interface PendingDiagnostic {
  captureOrder: number;
  diagnostic: MobileCrashDiagnostic;
  persistenceDeadline?: ReturnType<typeof setTimeout>;
  rejectPersistence?: (reason: unknown) => void;
  resolvePersistence?: () => void;
}

interface RetentionCandidate {
  captureOrder?: number;
  diagnostic: MobileCrashDiagnostic;
}

const EMPTY_CONTEXT: MobileCrashContext = {
  appState: "unknown",
  connectionMode: "unknown",
  connectionState: "unknown",
  forceCloudEnabled: false,
  selectedTaskId: null,
  terminalCols: null,
  terminalOutputChars: 0,
  terminalOutputEpoch: 0,
  terminalOutputStart: 0,
  terminalRows: null,
  terminalStatus: "unknown"
};

const UNKNOWN_BUILD: MobileCrashDiagnostic["build"] = {
  channel: "Unknown",
  environment: "unknown",
  nativeSummary: "Unknown",
  runtimeVersion: "Unknown",
  source: "Unknown"
};

export class MobileCrashDiagnosticRecorder {
  private context: MobileCrashContext = { ...EMPTY_CONTEXT };
  private breadcrumbs: MobileCrashBreadcrumb[] = [];
  private pendingDiagnostics: PendingDiagnostic[] = [];
  private persistenceQueue: Promise<void> | null = null;
  private nextCaptureOrder = 0;
  private retainedCaptures = new Map<string, RetentionCandidate>();

  constructor(
    private readonly storage: DiagnosticStorage,
    private readonly environment: DiagnosticEnvironment
  ) {}

  updateContext(context: MobileCrashContext): void {
    const previous = this.context;
    this.context = { ...context };
    if (
      previous.connectionMode !== context.connectionMode ||
      previous.connectionState !== context.connectionState ||
      previous.forceCloudEnabled !== context.forceCloudEnabled ||
      previous.selectedTaskId !== context.selectedTaskId ||
      previous.terminalStatus !== context.terminalStatus
    ) {
      this.addBreadcrumb(
        "runtime-context",
        [
          `connection=${context.connectionState}/${context.connectionMode}`,
          `forceCloud=${String(context.forceCloudEnabled)}`,
          `task=${context.selectedTaskId ?? "none"}`,
          `terminal=${context.terminalStatus}`
        ].join(" ")
      );
    }
  }

  addBreadcrumb(
    category: MobileCrashBreadcrumb["category"],
    message: string
  ): void {
    this.breadcrumbs = [
      ...this.breadcrumbs,
      {
        at: this.environment.now().toISOString(),
        category,
        message: redactAndTruncate(message, MAX_MESSAGE_LENGTH)
      }
    ].slice(-MAX_BREADCRUMBS);
  }

  capture(input: MobileCrashDiagnosticInput): MobileCrashDiagnostic {
    return this.enqueueDiagnostic(input).diagnostic;
  }

  captureWithPersistence(
    input: MobileCrashDiagnosticInput
  ): MobileCrashDiagnosticCapture {
    return this.enqueueDiagnostic(input, true);
  }

  private enqueueDiagnostic(
    input: MobileCrashDiagnosticInput,
    trackPersistence = false
  ): MobileCrashDiagnosticCapture {
    const at = this.environment.now();
    const captureOrder = this.nextCaptureOrder;
    this.nextCaptureOrder += 1;
    let build = UNKNOWN_BUILD;
    try {
      build = this.environment.readBuild();
    } catch (error: unknown) {
      this.addBreadcrumb(
        "runtime-context",
        `build-identity-unavailable=${formatErrorMessage(error)}`
      );
    }
    const diagnosticId = [
      at.getTime().toString(36),
      captureOrder.toString(36),
      this.environment.randomId()
    ].join("-");
    const diagnostic: MobileCrashDiagnostic = {
      schemaVersion: 1,
      id: diagnosticId,
      at: at.toISOString(),
      kind: input.kind,
      fatal: input.fatal === true,
      message: redactAndTruncate(input.message, MAX_MESSAGE_LENGTH),
      ...(input.stack
        ? { stack: redactAndTruncate(input.stack, MAX_STACK_LENGTH) }
        : {}),
      ...(input.componentStack
        ? {
            componentStack: redactAndTruncate(
              input.componentStack,
              MAX_STACK_LENGTH
            )
          }
        : {}),
      ...(input.details ? { details: normalizeDetails(input.details) } : {}),
      context: { ...this.context, appState: AppState.currentState },
      breadcrumbs: [...this.breadcrumbs],
      build
    };
    let resolvePersistence: (() => void) | undefined;
    let rejectPersistence: ((reason: unknown) => void) | undefined;
    const persistence = trackPersistence
      ? new Promise<void>((resolve, reject) => {
          resolvePersistence = resolve;
          rejectPersistence = reject;
        })
      : Promise.resolve();
    const pending: PendingDiagnostic = {
      captureOrder,
      diagnostic,
      ...(resolvePersistence ? { resolvePersistence } : {}),
      ...(rejectPersistence ? { rejectPersistence } : {})
    };
    if (resolvePersistence) {
      pending.persistenceDeadline = setTimeout(() => {
        this.rejectTrackedPersistence(
          pending,
          new Error("Mobile crash diagnostic persistence timed out.")
        );
        this.trimPendingDiagnostics();
      }, GLOBAL_HANDLER_PERSISTENCE_DEADLINE_MS);
    }
    this.pendingDiagnostics.unshift(pending);
    this.trimPendingDiagnostics();
    this.startPersistence();
    return {
      diagnostic,
      persistence,
      releasePersistenceTracking: () => {
        this.resolveTrackedPersistence(pending);
        this.trimPendingDiagnostics();
      }
    };
  }

  private trimPendingDiagnostics(): void {
    let trackedCount = 0;
    let untrackedCount = 0;
    this.pendingDiagnostics = this.pendingDiagnostics.filter((entry) => {
      if (entry.resolvePersistence) {
        trackedCount += 1;
        if (trackedCount <= MAX_DIAGNOSTICS) return true;
        this.rejectTrackedPersistence(
          entry,
          new Error("Mobile crash diagnostic persistence backlog exceeded.")
        );
        return false;
      }
      untrackedCount += 1;
      if (untrackedCount <= MAX_DIAGNOSTICS) return true;
      return false;
    });
  }

  private rejectTrackedPersistence(
    entry: PendingDiagnostic,
    reason: Error
  ): void {
    const reject = entry.rejectPersistence;
    if (!reject) return;
    if (entry.persistenceDeadline) clearTimeout(entry.persistenceDeadline);
    delete entry.persistenceDeadline;
    delete entry.rejectPersistence;
    delete entry.resolvePersistence;
    reject(reason);
  }

  private resolveTrackedPersistence(entry: PendingDiagnostic): void {
    const resolve = entry.resolvePersistence;
    if (!resolve) return;
    if (entry.persistenceDeadline) clearTimeout(entry.persistenceDeadline);
    delete entry.persistenceDeadline;
    delete entry.rejectPersistence;
    delete entry.resolvePersistence;
    resolve();
  }

  async read(): Promise<MobileCrashDiagnostic[]> {
    while (this.persistenceQueue) {
      await this.persistenceQueue;
    }
    return this.readStored();
  }

  async clear(): Promise<void> {
    await this.waitForPersistence();
    await this.storage.removeItem(DIAGNOSTICS_STORAGE_KEY);
    this.retainedCaptures.clear();
  }

  private async waitForPersistence(): Promise<void> {
    while (this.persistenceQueue) {
      await this.persistenceQueue;
    }
  }

  private startPersistence(): void {
    if (this.persistenceQueue) return;

    const persistence = this.flushPendingDiagnostics()
      .catch((error: unknown) => {
        console.warn("Mobile crash diagnostic persistence failed:", error);
      })
      .finally(() => {
        if (this.persistenceQueue === persistence) {
          this.persistenceQueue = null;
        }
        if (this.pendingDiagnostics.length > 0) {
          this.startPersistence();
        }
      });
    this.persistenceQueue = persistence;
  }

  private async flushPendingDiagnostics(): Promise<void> {
    while (this.pendingDiagnostics.length > 0) {
      let trackedIndex = -1;
      for (
        let index = this.pendingDiagnostics.length - 1;
        index >= 0;
        index -= 1
      ) {
        if (this.pendingDiagnostics[index].resolvePersistence) {
          trackedIndex = index;
          break;
        }
      }
      const batch =
        trackedIndex >= 0
          ? this.pendingDiagnostics.splice(trackedIndex, 1)
          : this.pendingDiagnostics.splice(0, MAX_DIAGNOSTICS);
      try {
        const previous = await this.readStored();
        // Live batch candidates come first so an untrusted stored ID collision
        // cannot replace the capture or consume a second retention slot.
        const retainedCandidates = this.deduplicateRetentionCandidates([
          ...batch.map((entry) => ({
            captureOrder: entry.captureOrder,
            diagnostic: entry.diagnostic
          })),
          ...previous.map(
            (diagnostic) =>
              this.retainedCaptures.get(diagnostic.id) ?? { diagnostic }
          )
        ])
          .sort((left, right) => this.compareRetentionOrder(left, right))
          .slice(0, MAX_DIAGNOSTICS);
        const retained = retainedCandidates.map(
          (candidate) => candidate.diagnostic
        );
        await this.storage.setItem(
          DIAGNOSTICS_STORAGE_KEY,
          JSON.stringify(retained)
        );
        this.retainedCaptures = new Map(
          retainedCandidates
            .filter((candidate) => candidate.captureOrder !== undefined)
            .map((candidate) => [candidate.diagnostic.id, candidate])
        );
        for (const entry of batch) this.resolveTrackedPersistence(entry);
      } catch (error: unknown) {
        for (const entry of batch) {
          this.rejectTrackedPersistence(
            entry,
            error instanceof Error ? error : new Error(String(error))
          );
        }
        throw error;
      }
    }
  }

  private compareRetentionOrder(
    left: RetentionCandidate,
    right: RetentionCandidate
  ): number {
    // Persisted timestamps are untrusted. Captures from this recorder use their
    // actual enqueue order and always outrank records loaded from storage.
    const leftCaptureOrder = left.captureOrder;
    const rightCaptureOrder = right.captureOrder;
    if (leftCaptureOrder !== undefined && rightCaptureOrder !== undefined) {
      return rightCaptureOrder - leftCaptureOrder;
    }
    if (leftCaptureOrder !== undefined) return -1;
    if (rightCaptureOrder !== undefined) return 1;

    const leftTimestamp = Date.parse(left.diagnostic.at);
    const rightTimestamp = Date.parse(right.diagnostic.at);
    const leftHasValidTimestamp = Number.isFinite(leftTimestamp);
    const rightHasValidTimestamp = Number.isFinite(rightTimestamp);
    if (leftHasValidTimestamp !== rightHasValidTimestamp) {
      return leftHasValidTimestamp ? -1 : 1;
    }
    if (!leftHasValidTimestamp) return 0;
    return rightTimestamp - leftTimestamp;
  }

  private deduplicateRetentionCandidates(
    candidates: RetentionCandidate[]
  ): RetentionCandidate[] {
    const uniqueCandidates = new Map<string, RetentionCandidate>();
    for (const candidate of candidates) {
      if (!uniqueCandidates.has(candidate.diagnostic.id)) {
        uniqueCandidates.set(candidate.diagnostic.id, candidate);
      }
    }
    return [...uniqueCandidates.values()];
  }

  private async readStored(): Promise<MobileCrashDiagnostic[]> {
    const raw = await this.storage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isMobileCrashDiagnostic)
        .slice(0, MAX_DIAGNOSTICS)
        .map(redactMobileCrashDiagnostic);
    } catch (error: unknown) {
      console.warn("Stored mobile crash diagnostics could not be parsed:", error);
      return [];
    }
  }
}

function currentBuild(): MobileCrashDiagnostic["build"] {
  const identity = getCurrentBuildIdentity();
  return {
    channel: identity.channel,
    environment: identity.environment,
    nativeSummary: identity.nativeSummary,
    runtimeVersion: identity.runtimeVersion,
    source: identity.source.label
  };
}

const recorder = new MobileCrashDiagnosticRecorder(AsyncStorage, {
  now: () => new Date(),
  randomId: () => Math.random().toString(36).slice(2, 8),
  readBuild: currentBuild
});

export function updateMobileCrashContext(context: MobileCrashContext): void {
  recorder.updateContext(context);
}

export function addMobileCrashBreadcrumb(
  category: MobileCrashBreadcrumb["category"],
  message: string
): void {
  recorder.addBreadcrumb(category, message);
}

export function captureMobileCrashDiagnostic(
  input: MobileCrashDiagnosticInput
): MobileCrashDiagnostic {
  return recorder.capture(input);
}

export function captureMobileCrashDiagnosticWithPersistence(
  input: MobileCrashDiagnosticInput
): MobileCrashDiagnosticCapture {
  return recorder.captureWithPersistence(input);
}

export function readMobileCrashDiagnostics(): Promise<MobileCrashDiagnostic[]> {
  return recorder.read();
}

export function clearMobileCrashDiagnostics(): Promise<void> {
  return recorder.clear();
}

export function formatMobileCrashDiagnostics(
  diagnostics: readonly MobileCrashDiagnostic[]
): string {
  return JSON.stringify(diagnostics.map(redactMobileCrashDiagnostic), null, 2);
}

interface ReactNativeErrorUtils {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(
    handler: (error: unknown, isFatal?: boolean) => void
  ): void;
}

interface DiagnosticGlobal {
  ErrorUtils?: ReactNativeErrorUtils;
  __kannaMobileCrashHandlerInstalled?: boolean;
}

export function installMobileCrashHandler(
  capture: (
    input: MobileCrashDiagnosticInput
  ) => MobileCrashDiagnosticCapture = captureMobileCrashDiagnosticWithPersistence
): void {
  const diagnosticGlobal = globalThis as typeof globalThis & DiagnosticGlobal;
  const errorUtils = diagnosticGlobal.ErrorUtils;
  if (!errorUtils || diagnosticGlobal.__kannaMobileCrashHandlerInstalled) {
    return;
  }

  diagnosticGlobal.__kannaMobileCrashHandlerInstalled = true;
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    let delegated = false;
    const delegate = () => {
      if (delegated) return;
      delegated = true;
      previousHandler(error, isFatal);
    };

    try {
      const normalized = normalizeError(error);
      const attempt = capture({
        kind: "javascript-error",
        fatal: isFatal === true,
        message: normalized.message,
        stack: normalized.stack
      });
      if (isFatal !== true) {
        attempt.releasePersistenceTracking();
        delegate();
        return;
      }
      let pendingDelegate: (() => void) | null = delegate;
      const finishDelegation = () => {
        const currentDelegate = pendingDelegate;
        pendingDelegate = null;
        currentDelegate?.();
      };
      const fallback = setTimeout(
        finishDelegation,
        GLOBAL_HANDLER_PERSISTENCE_DEADLINE_MS
      );
      void Promise.resolve(attempt.persistence).then(
        () => {
          clearTimeout(fallback);
          finishDelegation();
        },
        () => {
          clearTimeout(fallback);
          finishDelegation();
        }
      );
    } catch {
      console.warn(
        "Mobile crash diagnostic capture failed before persistence completed."
      );
      delegate();
    }
  });
}

function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return { message: formatErrorMessage(error) };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeDetails(
  details: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(details)
      .filter((entry): entry is [string, string | number | boolean | null] =>
        entry[1] !== undefined
      )
      .map(([key, value]) => [
        key,
        typeof value === "string"
          ? SENSITIVE_FIELD_PATTERN.test(key)
            ? REDACTED_VALUE
            : redactAndTruncate(value, MAX_MESSAGE_LENGTH)
          : value
      ])
  );
}

function redactMobileCrashDiagnostic(
  diagnostic: MobileCrashDiagnostic
): MobileCrashDiagnostic {
  return {
    ...diagnostic,
    message: redactAndTruncate(diagnostic.message, MAX_MESSAGE_LENGTH),
    ...(diagnostic.stack
      ? { stack: redactAndTruncate(diagnostic.stack, MAX_STACK_LENGTH) }
      : {}),
    ...(diagnostic.componentStack
      ? {
          componentStack: redactAndTruncate(
            diagnostic.componentStack,
            MAX_STACK_LENGTH
          )
        }
      : {}),
    ...(diagnostic.details
      ? { details: normalizeDetails(diagnostic.details) }
      : {}),
    breadcrumbs: diagnostic.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      message: redactAndTruncate(breadcrumb.message, MAX_MESSAGE_LENGTH)
    }))
  };
}

function redactAndTruncate(value: string, length: number): string {
  const truncated = truncate(value, length);
  const boundarySafe =
    value.length > length
      ? redactUnterminatedUrlAuthority(truncated)
      : truncated;
  return truncate(redactSensitiveText(boundarySafe), length);
}

function redactUnterminatedUrlAuthority(value: string): string {
  return value.replace(
    /(\bhttps?:\/\/)[^/\s?#@]*…$/gi,
    `$1${REDACTED_VALUE}…`
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /(\bhttps?:\/\/)[^/\s?#@]+@/gi,
      `$1${REDACTED_VALUE}@`
    )
    .replace(
      /([?&](?:authorization|proxy[_-]?authorization|[A-Za-z0-9_.-]*(?:token|password|passwd|secret|credential)|api[_-]?key|cookie|session)=)[^&#\s]*/gi,
      `$1${REDACTED_VALUE}`
    )
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED_VALUE}`
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED_VALUE}`)
    .replace(
      /(["']?(?:authorization|proxy[_-]?authorization|[A-Za-z0-9_.-]*(?:token|password|passwd|secret|credential)|api[_-]?key|cookie|session)["']?\s*[:=]\s*)(["'])[^"']*\2/gi,
      `$1$2${REDACTED_VALUE}$2`
    )
    .replace(
      /(\b(?:authorization|proxy[_-]?authorization|[A-Za-z0-9_.-]*(?:token|password|passwd|secret|credential)|api[_-]?key|cookie|session)\b\s*[:=]\s*)(?!\[REDACTED\])[^,\s;}\]&]+/gi,
      `$1${REDACTED_VALUE}`
    );
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function isMobileCrashDiagnostic(value: unknown): value is MobileCrashDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.at === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.context === "object" &&
    candidate.context !== null &&
    typeof candidate.build === "object" &&
    candidate.build !== null &&
    Array.isArray(candidate.breadcrumbs)
  );
}
