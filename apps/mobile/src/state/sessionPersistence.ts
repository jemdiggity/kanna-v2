import type { MobileView } from "./sessionStore";
import type { MobileAuthUser } from "../lib/firebase/auth";

const MOBILE_CONTEXT_STORAGE_KEY = "kanna.mobile.context.v1";

export interface PersistedSessionContext {
  selectedDesktopId: string | null;
  selectedRepoId: string | null;
  selectedTaskId: string | null;
  activeView: MobileView;
  authUser?: MobileAuthUser | null;
  trustedDesktops?: TrustedDesktopRecord[];
}

export interface TrustedDesktopLanEndpoint {
  baseUrl: string;
  lastSeenAt: string;
}

export interface TrustedDesktopRecord {
  desktopId: string;
  displayName: string;
  lanEndpoints: TrustedDesktopLanEndpoint[];
  lastSeenAt: string;
}

export interface SessionPersistence {
  load(): Promise<PersistedSessionContext | null>;
  save(context: PersistedSessionContext): Promise<void>;
}

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function createSessionPersistence(storage: StorageAdapter): SessionPersistence {
  return {
    async load() {
      const raw = await storage.getItem(MOBILE_CONTEXT_STORAGE_KEY);
      return parsePersistedSessionContext(raw);
    },
    async save(context) {
      await storage.setItem(
        MOBILE_CONTEXT_STORAGE_KEY,
        JSON.stringify(context)
      );
    }
  };
}

export async function createDefaultSessionPersistence(): Promise<SessionPersistence> {
  const module = await import("@react-native-async-storage/async-storage");
  return createSessionPersistence(module.default as StorageAdapter);
}

function parsePersistedSessionContext(
  raw: string | null
): PersistedSessionContext | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionContext>;
    if (!isMobileView(parsed.activeView)) {
      return null;
    }

    return {
      selectedDesktopId: normalizeNullableString(parsed.selectedDesktopId),
      selectedRepoId: normalizeNullableString(parsed.selectedRepoId),
      selectedTaskId: normalizeNullableString(parsed.selectedTaskId),
      activeView: parsed.activeView,
      authUser: parsePersistedAuthUser(parsed.authUser),
      trustedDesktops: parseTrustedDesktops(parsed.trustedDesktops)
    };
  } catch {
    return null;
  }
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isMobileView(value: unknown): value is MobileView {
  return (
    value === "tasks" ||
    value === "recent" ||
    value === "search" ||
    value === "desktops" ||
    value === "more"
  );
}

function parsePersistedAuthUser(value: unknown): MobileAuthUser | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<MobileAuthUser>;
  if (typeof candidate.uid !== "string") {
    return null;
  }

  return {
    uid: candidate.uid,
    email: normalizeNullableString(candidate.email),
    displayName: normalizeNullableString(candidate.displayName)
  };
}

function parseTrustedDesktops(value: unknown): TrustedDesktopRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Partial<TrustedDesktopRecord>;
    if (
      typeof candidate.desktopId !== "string" ||
      typeof candidate.displayName !== "string"
    ) {
      return [];
    }

    const lanEndpoints = parseTrustedDesktopLanEndpoints(candidate.lanEndpoints);
    if (lanEndpoints.length === 0) {
      return [];
    }

    return [
      {
        desktopId: candidate.desktopId,
        displayName: candidate.displayName,
        lanEndpoints,
        lastSeenAt:
          typeof candidate.lastSeenAt === "string"
            ? candidate.lastSeenAt
            : lanEndpoints[0]!.lastSeenAt
      }
    ];
  });
}

function parseTrustedDesktopLanEndpoints(value: unknown): TrustedDesktopLanEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Partial<TrustedDesktopLanEndpoint>;
    if (
      typeof candidate.baseUrl !== "string" ||
      typeof candidate.lastSeenAt !== "string"
    ) {
      return [];
    }

    return [
      {
        baseUrl: candidate.baseUrl,
        lastSeenAt: candidate.lastSeenAt
      }
    ];
  });
}
