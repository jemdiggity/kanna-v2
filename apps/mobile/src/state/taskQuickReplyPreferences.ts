import {
  DEFAULT_TASK_QUICK_REPLIES,
  normalizeTaskQuickReplies,
  type TaskQuickReply,
  validateTaskQuickReplies
} from "../screens/taskQuickReplies";

export const TASK_QUICK_REPLY_STORAGE_KEY = "kanna.mobile.quick-replies.v1";
const TASK_QUICK_REPLY_STORAGE_VERSION = 1;

export interface TaskQuickReplyStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface TaskQuickReplyPreferences {
  load(): Promise<TaskQuickReply[]>;
  save(replies: readonly TaskQuickReply[]): Promise<TaskQuickReply[]>;
}

interface StoredTaskQuickReplies {
  version: number;
  replies: unknown;
}

export function createTaskQuickReplyPreferences(
  storage: TaskQuickReplyStorageAdapter
): TaskQuickReplyPreferences {
  return {
    async load() {
      try {
        const raw = await storage.getItem(TASK_QUICK_REPLY_STORAGE_KEY);
        if (!raw) {
          return defaultTaskQuickReplies();
        }

        const envelope = JSON.parse(raw) as Partial<StoredTaskQuickReplies>;
        if (envelope.version !== TASK_QUICK_REPLY_STORAGE_VERSION) {
          return defaultTaskQuickReplies();
        }

        const replies = normalizeTaskQuickReplies(envelope.replies);
        return replies.length > 0 ? replies : defaultTaskQuickReplies();
      } catch {
        return defaultTaskQuickReplies();
      }
    },

    async save(replies) {
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

      await storage.setItem(
        TASK_QUICK_REPLY_STORAGE_KEY,
        JSON.stringify({
          version: TASK_QUICK_REPLY_STORAGE_VERSION,
          replies: normalized
        })
      );
      return normalized;
    }
  };
}

export async function createDefaultTaskQuickReplyPreferences(): Promise<TaskQuickReplyPreferences> {
  const module = await import("@react-native-async-storage/async-storage");
  return createTaskQuickReplyPreferences(
    module.default as TaskQuickReplyStorageAdapter
  );
}

function defaultTaskQuickReplies(): TaskQuickReply[] {
  return DEFAULT_TASK_QUICK_REPLIES.map((reply) => ({ ...reply }));
}
