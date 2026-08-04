import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { getCurrentBuildIdentity } from "../updates/buildIdentity";

const DIAGNOSTICS_STORAGE_KEY = "kanna.mobile.crash-diagnostics.v1";
const MAX_DIAGNOSTICS = 5;
const MAX_BREADCRUMBS = 20;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 12_000;
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
  private pendingDiagnostics: MobileCrashDiagnostic[] = [];
  private persistenceQueue: Promise<void> | null = null;

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
        message: truncate(redactSensitiveText(message), MAX_MESSAGE_LENGTH)
      }
    ].slice(-MAX_BREADCRUMBS);
  }

  capture(input: MobileCrashDiagnosticInput): MobileCrashDiagnostic {
    return this.enqueueDiagnostic(input);
  }

  captureWithPersistence(
    input: MobileCrashDiagnosticInput
  ): MobileCrashDiagnosticCapture {
    const diagnostic = this.enqueueDiagnostic(input);
    return {
      diagnostic,
      persistence: this.waitForPersistence()
    };
  }

  private enqueueDiagnostic(
    input: MobileCrashDiagnosticInput
  ): MobileCrashDiagnostic {
    const at = this.environment.now();
    let build = UNKNOWN_BUILD;
    try {
      build = this.environment.readBuild();
    } catch (error: unknown) {
      this.addBreadcrumb(
        "runtime-context",
        `build-identity-unavailable=${formatErrorMessage(error)}`
      );
    }
    const diagnostic: MobileCrashDiagnostic = {
      schemaVersion: 1,
      id: `${at.getTime().toString(36)}-${this.environment.randomId()}`,
      at: at.toISOString(),
      kind: input.kind,
      fatal: input.fatal === true,
      message: truncate(redactSensitiveText(input.message), MAX_MESSAGE_LENGTH),
      ...(input.stack
        ? { stack: truncate(redactSensitiveText(input.stack), MAX_STACK_LENGTH) }
        : {}),
      ...(input.componentStack
        ? {
            componentStack: truncate(
              redactSensitiveText(input.componentStack),
              MAX_STACK_LENGTH
            )
          }
        : {}),
      ...(input.details ? { details: normalizeDetails(input.details) } : {}),
      context: { ...this.context, appState: AppState.currentState },
      breadcrumbs: [...this.breadcrumbs],
      build
    };

    this.pendingDiagnostics = [diagnostic, ...this.pendingDiagnostics].slice(
      0,
      MAX_DIAGNOSTICS
    );
    this.startPersistence();
    return diagnostic;
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
      const batch = this.pendingDiagnostics.splice(0, MAX_DIAGNOSTICS);
      const previous = await this.readStored();
      await this.storage.setItem(
        DIAGNOSTICS_STORAGE_KEY,
        JSON.stringify([...batch, ...previous].slice(0, MAX_DIAGNOSTICS))
      );
    }
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
      void Promise.resolve(attempt.persistence).then(delegate, delegate);
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
          ? truncate(
              SENSITIVE_FIELD_PATTERN.test(key)
                ? REDACTED_VALUE
                : redactSensitiveText(value),
              MAX_MESSAGE_LENGTH
            )
          : value
      ])
  );
}

function redactMobileCrashDiagnostic(
  diagnostic: MobileCrashDiagnostic
): MobileCrashDiagnostic {
  return {
    ...diagnostic,
    message: redactSensitiveText(diagnostic.message),
    ...(diagnostic.stack
      ? { stack: redactSensitiveText(diagnostic.stack) }
      : {}),
    ...(diagnostic.componentStack
      ? { componentStack: redactSensitiveText(diagnostic.componentStack) }
      : {}),
    ...(diagnostic.details
      ? { details: normalizeDetails(diagnostic.details) }
      : {}),
    breadcrumbs: diagnostic.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      message: redactSensitiveText(breadcrumb.message)
    }))
  };
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
