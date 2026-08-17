import {
  DEFAULT_TASK_QUICK_REPLIES,
  normalizeTaskQuickReplies,
  type TaskQuickReply,
  validateTaskQuickReplies
} from "../screens/taskQuickReplies";

export const TASK_QUICK_REPLY_STORAGE_KEY = "kanna.mobile.quick-replies.v1";
export const TASK_QUICK_REPLY_BACKUP_STORAGE_KEY =
  "kanna.mobile.quick-replies.backup.v1";
export const TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY =
  "kanna.mobile.quick-replies.recovery.v1";
const TASK_QUICK_REPLY_STORAGE_VERSION = 1;

export interface TaskQuickReplyStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type TaskQuickReplyLoadResult =
  | {
      status: "loaded";
      replies: TaskQuickReply[];
    }
  | {
      status: "failed";
      replies: TaskQuickReply[];
    };

export interface TaskQuickReplySaveOptions {
  confirmReplacement?: boolean;
}

export interface TaskQuickReplyPreferences {
  load(): Promise<TaskQuickReplyLoadResult>;
  save(
    replies: readonly TaskQuickReply[],
    options?: TaskQuickReplySaveOptions
  ): Promise<TaskQuickReply[]>;
}

interface StoredTaskQuickReplies {
  version: number;
  replies: unknown;
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
      replies: TaskQuickReply[];
    }
  | FailedBaselineState;

export class TaskQuickReplySaveBlockedError extends Error {
  constructor(
    readonly reason:
      | "baseline-unresolved"
      | "load-failed"
      | "recovery-not-preserved"
  ) {
    super(
      reason === "baseline-unresolved"
        ? "Quick replies cannot be saved before preferences finish loading."
        : reason === "recovery-not-preserved"
          ? "Quick replies cannot be replaced because the stored data could not be preserved."
          : "Quick replies cannot be replaced without confirmation."
    );
    this.name = "TaskQuickReplySaveBlockedError";
  }
}

export function createTaskQuickReplyPreferences(
  storage: TaskQuickReplyStorageAdapter
): TaskQuickReplyPreferences {
  let baseline: BaselineState = { status: "unresolved" };
  let loadPromise: Promise<TaskQuickReplyLoadResult> | null = null;

  const load = (): Promise<TaskQuickReplyLoadResult> => {
    if (baseline.status === "loaded") {
      return Promise.resolve({
        status: "loaded",
        replies: copyReplies(baseline.replies)
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
            replies: copyReplies(loadedBaseline.replies)
          }
        : failedLoadResult();
    });
    return loadPromise;
  };

  return {
    load,

    async save(replies, options = {}) {
      if (baseline.status === "unresolved") {
        throw new TaskQuickReplySaveBlockedError("baseline-unresolved");
      }
      if (baseline.status === "failed") {
        if (!options.confirmReplacement) {
          throw new TaskQuickReplySaveBlockedError("load-failed");
        }
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
          throw new TaskQuickReplySaveBlockedError("recovery-not-preserved");
        }
      }

      const normalized = normalizeRepliesForSave(replies);
      const nextEnvelopeRaw = serializeEnvelope(normalized);

      if (baseline.status === "loaded") {
        await storage.setItem(
          TASK_QUICK_REPLY_BACKUP_STORAGE_KEY,
          baseline.envelopeRaw
        );
      }
      await storage.setItem(TASK_QUICK_REPLY_STORAGE_KEY, nextEnvelopeRaw);
      baseline = {
        status: "loaded",
        envelopeRaw: nextEnvelopeRaw,
        replies: normalized
      };
      return copyReplies(normalized);
    }
  };
}

export async function createDefaultTaskQuickReplyPreferences(): Promise<TaskQuickReplyPreferences> {
  const module = await import("@react-native-async-storage/async-storage");
  return createTaskQuickReplyPreferences(
    module.default as TaskQuickReplyStorageAdapter
  );
}

async function loadBaseline(
  storage: TaskQuickReplyStorageAdapter
): Promise<BaselineState> {
  let raw: string | null;
  try {
    raw = await storage.getItem(TASK_QUICK_REPLY_STORAGE_KEY);
  } catch {
    return failedBaseline("active-payload-unknown");
  }

  if (raw === null) {
    const replies = defaultTaskQuickReplies();
    return {
      status: "loaded",
      envelopeRaw: serializeEnvelope(replies),
      replies
    };
  }

  try {
    const envelope = JSON.parse(raw) as Partial<StoredTaskQuickReplies>;

    // A version bump must add an explicit migration above this check. Unknown
    // envelopes are preserved for recovery; they are never treated as absent.
    if (envelope.version !== TASK_QUICK_REPLY_STORAGE_VERSION) {
      return await preserveFailedBaseline(storage, raw);
    }

    const replies = normalizeTaskQuickReplies(envelope.replies);
    if (replies.length === 0) {
      return await preserveFailedBaseline(storage, raw);
    }

    return {
      status: "loaded",
      envelopeRaw: serializeEnvelope(replies),
      replies
    };
  } catch {
    return await preserveFailedBaseline(storage, raw);
  }
}

async function preserveFailedBaseline(
  storage: TaskQuickReplyStorageAdapter,
  raw: string
): Promise<FailedBaselineState> {
  try {
    await storage.setItem(TASK_QUICK_REPLY_RECOVERY_STORAGE_KEY, raw);
    return failedBaseline("active-payload-preserved");
  } catch {
    return failedBaseline("preservation-failed");
  }
}

async function retryRecoveryBeforeReplacement(
  storage: TaskQuickReplyStorageAdapter
): Promise<FailedBaselineState> {
  let raw: string | null;
  try {
    raw = await storage.getItem(TASK_QUICK_REPLY_STORAGE_KEY);
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

function failedLoadResult(): TaskQuickReplyLoadResult {
  return { status: "failed", replies: defaultTaskQuickReplies() };
}

function normalizeRepliesForSave(
  replies: readonly TaskQuickReply[]
): TaskQuickReply[] {
  const normalized = replies.map((reply) => ({
    id: reply.id.trim(),
    text: reply.text.trim()
  }));
  const idSet = new Set(normalized.map((reply) => reply.id));
  if (
    normalized.some((reply) => !reply.id) ||
    idSet.size !== normalized.length
  ) {
    throw new Error("Quick replies must have unique identifiers.");
  }

  const validation = validateTaskQuickReplies(normalized);
  if (!validation.valid) {
    throw new Error(
      validation.listError ??
        Object.values(validation.errors)[0] ??
        "Quick replies are invalid."
    );
  }
  return normalized;
}

function serializeEnvelope(replies: readonly TaskQuickReply[]): string {
  return JSON.stringify({
    version: TASK_QUICK_REPLY_STORAGE_VERSION,
    replies
  });
}

function copyReplies(replies: readonly TaskQuickReply[]): TaskQuickReply[] {
  return replies.map((reply) => ({ ...reply }));
}

function defaultTaskQuickReplies(): TaskQuickReply[] {
  return copyReplies(DEFAULT_TASK_QUICK_REPLIES);
}
