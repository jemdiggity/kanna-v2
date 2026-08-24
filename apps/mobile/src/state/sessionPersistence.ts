import type {
  ComposerAgentProvider,
  MobileView,
  PendingTaskCreation
} from "./sessionStore";
import type { MobileAuthUser } from "../lib/firebase/auth";
import type {
  DesktopPushIdentity,
  PushPairingCertificate
} from "../lib/api/types";
import { isAgentProvider } from "@kanna/agent-protocol";

const MOBILE_CONTEXT_STORAGE_KEY = "kanna.mobile.context.v1";

export interface PersistedSessionContext {
  mobileDeviceId: string | null;
  selectedDesktopId: string | null;
  selectedRepoId: string | null;
  selectedTaskId: string | null;
  activeView: MobileView;
  authUser?: MobileAuthUser | null;
  trustedDesktops?: TrustedDesktopRecord[];
  repoCreationProfiles?: RepoCreationProfile[];
  taskCreationAttempts?: PendingTaskCreation[];
  /** Legacy singleton retained for migration from older mobile builds. */
  pendingTaskCreation?: PendingTaskCreation | null;
}

export interface RepoCreationProfile {
  repoId: string;
  desktopId: string;
  agentProvider: ComposerAgentProvider;
  updatedAt: string;
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
  /** LAN credential issued when this machine was paired; absent for
   * machines paired before device secrets existed. */
  deviceSecret?: string;
  /** Pair-scoped anonymous push material issued by this desktop. */
  desktopPushIdentity?: DesktopPushIdentity;
  pushPairingCert?: PushPairingCertificate;
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

    const taskCreationAttempts = Array.isArray(parsed.taskCreationAttempts)
      ? parsePendingTaskCreations(parsed.taskCreationAttempts)
      : parsePendingTaskCreations([parsed.pendingTaskCreation]);
    return {
      mobileDeviceId: isNonBlankString(parsed.mobileDeviceId)
        ? parsed.mobileDeviceId.trim()
        : null,
      selectedDesktopId: normalizeNullableString(parsed.selectedDesktopId),
      selectedRepoId: normalizeNullableString(parsed.selectedRepoId),
      selectedTaskId: normalizeNullableString(parsed.selectedTaskId),
      activeView: parsed.activeView,
      authUser: parsePersistedAuthUser(parsed.authUser),
      trustedDesktops: parseTrustedDesktops(parsed.trustedDesktops),
      repoCreationProfiles: parseRepoCreationProfiles(parsed.repoCreationProfiles),
      taskCreationAttempts,
      pendingTaskCreation: taskCreationAttempts[0] ?? null
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
    displayName: normalizeNullableString(candidate.displayName),
    emailVerified: typeof candidate.emailVerified === "boolean"
      ? candidate.emailVerified
      : undefined,
    cloudAccess:
      candidate.cloudAccess === "active" ||
      candidate.cloudAccess === "inactive" ||
      candidate.cloudAccess === "unknown"
        ? candidate.cloudAccess
        : undefined
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

    const pushMaterial = parsePushPairingMaterial(
      candidate.desktopPushIdentity,
      candidate.pushPairingCert
    );
    return [
      {
        desktopId: candidate.desktopId,
        displayName: candidate.displayName,
        lanEndpoints,
        lastSeenAt:
          typeof candidate.lastSeenAt === "string"
            ? candidate.lastSeenAt
            : lanEndpoints[0]?.lastSeenAt ?? new Date(0).toISOString(),
        ...(typeof candidate.deviceSecret === "string" && candidate.deviceSecret
          ? { deviceSecret: candidate.deviceSecret }
          : {}),
        ...pushMaterial
      }
    ];
  });
}

function parsePushPairingMaterial(
  identity: unknown,
  certificate: unknown
): Pick<TrustedDesktopRecord, "desktopPushIdentity" | "pushPairingCert"> {
  if (
    !identity ||
    typeof identity !== "object" ||
    !certificate ||
    typeof certificate !== "object"
  ) {
    return {};
  }
  const candidateIdentity = identity as Partial<DesktopPushIdentity>;
  const candidateCertificate = certificate as Partial<PushPairingCertificate>;
  const issuedAt = candidateCertificate.issuedAt;
  const expiresAt = candidateCertificate.expiresAt;
  if (
    !isNonBlankString(candidateIdentity.publicKey) ||
    typeof candidateIdentity.relayUrl !== "string" ||
    !isNonBlankString(candidateIdentity.environment) ||
    !isNonBlankString(candidateCertificate.deviceId) ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    !isNonBlankString(candidateCertificate.signature)
  ) {
    return {};
  }
  return {
    desktopPushIdentity: {
      publicKey: candidateIdentity.publicKey,
      relayUrl: candidateIdentity.relayUrl,
      environment: candidateIdentity.environment
    },
    pushPairingCert: {
      deviceId: candidateCertificate.deviceId,
      issuedAt,
      expiresAt,
      signature: candidateCertificate.signature
    }
  };
}

function parseRepoCreationProfiles(value: unknown): RepoCreationProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles = new Map<string, RepoCreationProfile>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Partial<RepoCreationProfile>;
    if (
      typeof candidate.repoId !== "string" ||
      typeof candidate.desktopId !== "string" ||
      !isAgentProvider(candidate.agentProvider)
    ) {
      continue;
    }

    profiles.set(candidate.repoId, {
      repoId: candidate.repoId,
      desktopId: candidate.desktopId,
      agentProvider: candidate.agentProvider,
      updatedAt:
        typeof candidate.updatedAt === "string"
          ? candidate.updatedAt
          : new Date(0).toISOString()
    });
  }

  return Array.from(profiles.values());
}

function parsePendingTaskCreation(value: unknown): PendingTaskCreation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PendingTaskCreation>;
  if (
    typeof candidate.taskId !== "string" ||
    !/^[0-9a-f]{8,64}$/.test(candidate.taskId) ||
    !isNonBlankString(candidate.repoId) ||
    !isNonBlankString(candidate.prompt) ||
    !isNonBlankString(candidate.desktopId) ||
    !isAgentProvider(candidate.agentProvider)
  ) {
    return null;
  }

  const slotId = candidate.slotId === undefined
    ? `create:${candidate.taskId}`
    : isNonBlankString(candidate.slotId) &&
        candidate.slotId.startsWith("create:")
      ? candidate.slotId
      : null;
  if (!slotId) {
    return null;
  }

  return {
    slotId,
    taskId: candidate.taskId,
    repoId: candidate.repoId,
    prompt: candidate.prompt,
    desktopId: candidate.desktopId,
    agentProvider: candidate.agentProvider,
    ...(Number.isInteger(candidate.terminalCols) &&
    Number.isInteger(candidate.terminalRows) &&
    (candidate.terminalCols ?? 0) > 0 &&
    (candidate.terminalRows ?? 0) > 0
      ? {
          terminalCols: candidate.terminalCols,
          terminalRows: candidate.terminalRows
        }
      : {})
  };
}

function parsePendingTaskCreations(value: readonly unknown[]): PendingTaskCreation[] {
  const attempts: PendingTaskCreation[] = [];
  const slotIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const entry of value) {
    const attempt = parsePendingTaskCreation(entry);
    if (
      !attempt ||
      slotIds.has(attempt.slotId) ||
      taskIds.has(attempt.taskId)
    ) {
      continue;
    }
    slotIds.add(attempt.slotId);
    taskIds.add(attempt.taskId);
    attempts.push(attempt);
  }
  return attempts;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
