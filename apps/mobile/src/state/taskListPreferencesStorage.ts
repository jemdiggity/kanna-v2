import {
  emptyLocalTaskListPreferences,
  normalizeLocalTaskListPreferences,
  type LocalTaskListPreferences
} from "./taskListPreferences";

export const TASK_LIST_PREFERENCES_STORAGE_KEY = "kanna.mobile.task-list.v1";
export const TASK_LIST_PREFERENCES_BACKUP_STORAGE_KEY =
  "kanna.mobile.task-list.backup.v1";
export const TASK_LIST_PREFERENCES_RECOVERY_STORAGE_KEY =
  "kanna.mobile.task-list.recovery.v1";
const TASK_LIST_PREFERENCES_STORAGE_VERSION = 1;

export interface TaskListPreferencesStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type TaskListPreferencesLoadResult =
  | { status: "loaded"; preferences: LocalTaskListPreferences }
  | { status: "failed"; preferences: LocalTaskListPreferences };

export interface TaskListPreferencesStore {
  load(): Promise<TaskListPreferencesLoadResult>;
  save(
    preferences: LocalTaskListPreferences
  ): Promise<LocalTaskListPreferences>;
}

interface StoredTaskListPreferences {
  version: number;
  preferences: unknown;
}

interface FailedBaselineState {
  status: "failed";
  recoveryState:
    | "active-payload-unknown"
    | "active-payload-absent"
    | "active-payload-preserved"
    | "preservation-failed";
}

type BaselineState =
  | { status: "unresolved" }
  | {
      status: "loaded";
      envelopeRaw: string;
      preferences: LocalTaskListPreferences;
    }
  | FailedBaselineState;

export class TaskListPreferencesSaveBlockedError extends Error {
  constructor(
    readonly reason: "baseline-unresolved" | "recovery-not-preserved"
  ) {
    super(
      reason === "baseline-unresolved"
        ? "Pinned and dismissed tasks cannot be saved before they finish loading."
        : "Pinned and dismissed tasks cannot be replaced because the stored data could not be preserved."
    );
    this.name = "TaskListPreferencesSaveBlockedError";
  }
}

/**
 * The phone's own pin/dismiss record, kept in AsyncStorage.
 *
 * A read this module cannot understand is never treated as "no pins": the
 * unreadable payload is copied to the recovery key before anything replaces
 * it, and the load reports `failed` so the caller can say so. Unlike quick
 * replies there is no editor to confirm a replacement through — pinning would
 * be silently dead forever if a failed read blocked writing — so once the
 * bytes are preserved, saving is allowed again. A read that failed outright
 * (storage threw, nothing preserved) still blocks the write, because there is
 * nothing to lose data against.
 */
export function createTaskListPreferencesStore(
  storage: TaskListPreferencesStorageAdapter
): TaskListPreferencesStore {
  let baseline: BaselineState = { status: "unresolved" };
  let loadPromise: Promise<TaskListPreferencesLoadResult> | null = null;

  const load = (): Promise<TaskListPreferencesLoadResult> => {
    if (baseline.status === "loaded") {
      return Promise.resolve({
        status: "loaded",
        preferences: copyPreferences(baseline.preferences)
      });
    }
    if (baseline.status === "failed") {
      return Promise.resolve(failedLoadResult());
    }
    if (loadPromise) {
      return loadPromise;
    }

    loadPromise = loadBaseline(storage).then((loadedBaseline) => {
      baseline = loadedBaseline;
      return loadedBaseline.status === "loaded"
        ? {
            status: "loaded" as const,
            preferences: copyPreferences(loadedBaseline.preferences)
          }
        : failedLoadResult();
    });
    return loadPromise;
  };

  return {
    load,

    async save(preferences) {
      if (baseline.status === "unresolved") {
        throw new TaskListPreferencesSaveBlockedError("baseline-unresolved");
      }
      if (baseline.status === "failed") {
        let recoveryState = baseline.recoveryState;
        if (recoveryState === "active-payload-unknown") {
          const recoveredBaseline =
            await retryRecoveryBeforeReplacement(storage);
          baseline = recoveredBaseline;
          recoveryState = recoveredBaseline.recoveryState;
        }
        if (
          recoveryState === "active-payload-unknown" ||
          recoveryState === "preservation-failed"
        ) {
          throw new TaskListPreferencesSaveBlockedError(
            "recovery-not-preserved"
          );
        }
      }

      const normalized = copyPreferences(preferences);
      const nextEnvelopeRaw = serializeEnvelope(normalized);

      if (baseline.status === "loaded") {
        await storage.setItem(
          TASK_LIST_PREFERENCES_BACKUP_STORAGE_KEY,
          baseline.envelopeRaw
        );
      }
      await storage.setItem(
        TASK_LIST_PREFERENCES_STORAGE_KEY,
        nextEnvelopeRaw
      );
      baseline = {
        status: "loaded",
        envelopeRaw: nextEnvelopeRaw,
        preferences: normalized
      };
      return copyPreferences(normalized);
    }
  };
}

export function createDefaultTaskListPreferencesStore(): TaskListPreferencesStore {
  return createTaskListPreferencesStore(createAsyncStorageAdapter());
}

/**
 * AsyncStorage, imported on first use. The store is constructed synchronously
 * with the controller, but the native module must not be pulled in until
 * something actually reads or writes preferences.
 */
function createAsyncStorageAdapter(): TaskListPreferencesStorageAdapter {
  let modulePromise: Promise<TaskListPreferencesStorageAdapter> | null = null;
  const resolveStorage = (): Promise<TaskListPreferencesStorageAdapter> => {
    modulePromise ??= import(
      "@react-native-async-storage/async-storage"
    ).then((module) => module.default as TaskListPreferencesStorageAdapter);
    return modulePromise;
  };
  return {
    async getItem(key) {
      return (await resolveStorage()).getItem(key);
    },
    async setItem(key, value) {
      await (await resolveStorage()).setItem(key, value);
    }
  };
}

async function loadBaseline(
  storage: TaskListPreferencesStorageAdapter
): Promise<BaselineState> {
  let raw: string | null;
  try {
    raw = await storage.getItem(TASK_LIST_PREFERENCES_STORAGE_KEY);
  } catch {
    return failedBaseline("active-payload-unknown");
  }

  if (raw === null) {
    const preferences = emptyLocalTaskListPreferences();
    return {
      status: "loaded",
      envelopeRaw: serializeEnvelope(preferences),
      preferences
    };
  }

  try {
    const envelope = JSON.parse(raw) as Partial<StoredTaskListPreferences>;

    // A version bump must add an explicit migration above this check. Unknown
    // envelopes are preserved for recovery; they are never treated as absent.
    if (envelope.version !== TASK_LIST_PREFERENCES_STORAGE_VERSION) {
      return await preserveFailedBaseline(storage, raw);
    }

    const preferences = normalizeLocalTaskListPreferences(envelope.preferences);
    if (!preferences) {
      return await preserveFailedBaseline(storage, raw);
    }

    return {
      status: "loaded",
      envelopeRaw: serializeEnvelope(preferences),
      preferences
    };
  } catch {
    return await preserveFailedBaseline(storage, raw);
  }
}

async function preserveFailedBaseline(
  storage: TaskListPreferencesStorageAdapter,
  raw: string
): Promise<FailedBaselineState> {
  try {
    await storage.setItem(TASK_LIST_PREFERENCES_RECOVERY_STORAGE_KEY, raw);
    return failedBaseline("active-payload-preserved");
  } catch {
    return failedBaseline("preservation-failed");
  }
}

async function retryRecoveryBeforeReplacement(
  storage: TaskListPreferencesStorageAdapter
): Promise<FailedBaselineState> {
  let raw: string | null;
  try {
    raw = await storage.getItem(TASK_LIST_PREFERENCES_STORAGE_KEY);
  } catch {
    return failedBaseline("active-payload-unknown");
  }

  if (raw === null) {
    return failedBaseline("active-payload-absent");
  }
  return preserveFailedBaseline(storage, raw);
}

function failedBaseline(
  recoveryState: FailedBaselineState["recoveryState"]
): FailedBaselineState {
  return { status: "failed", recoveryState };
}

function failedLoadResult(): TaskListPreferencesLoadResult {
  return { status: "failed", preferences: emptyLocalTaskListPreferences() };
}

function serializeEnvelope(preferences: LocalTaskListPreferences): string {
  return JSON.stringify({
    version: TASK_LIST_PREFERENCES_STORAGE_VERSION,
    preferences
  });
}

function copyPreferences(
  preferences: LocalTaskListPreferences
): LocalTaskListPreferences {
  return {
    pins: preferences.pins.map((pin) => ({ ...pin })),
    unpinnedDefaults: preferences.unpinnedDefaults.map((pin) => ({ ...pin })),
    dismissedActivity: preferences.dismissedActivity.map((entry) => ({
      ...entry
    })),
    pinsSeededFromServer: preferences.pinsSeededFromServer
  };
}
