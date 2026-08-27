import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import { getFirebaseServices } from "./firebase.js";
import {
  diagnoseMessagingFailure,
  type MobileNotification,
  type MobileNotificationDelivery,
} from "./mobileNotifications.js";

export const ANONYMOUS_PUSH_PAIRINGS_COLLECTION = "anonymousPushPairings";
export const ANONYMOUS_AUTH_DOMAIN = Buffer.from("kanna.relay-auth.v1\0", "utf8");
const PAIRING_CERT_DOMAIN = Buffer.from("kanna.push-pairing-cert.v1\0", "utf8");
const STALE_BINDING_MS = 180 * 24 * 60 * 60 * 1_000;
const MAX_CERTIFICATE_LIFETIME_MS = 731 * 24 * 60 * 60_000;
const MAX_DEVICES_PER_DESKTOP = 10;
const MAX_DESKTOPS_PER_TOKEN = 20;
const MAX_ACCOUNT_PUSH_DEVICES = 500;
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-argument",
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

export interface AnonymousPushCertificate {
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface AnonymousPushPairingRequest {
  desktopPubKey: string;
  deviceId: string;
  fcmToken: string;
  cert: AnonymousPushCertificate;
}

export interface AnonymousPushPairingRevocation {
  desktopPubKey: string;
  deviceId: string;
  cert: AnonymousPushCertificate;
}

interface AnonymousPushPairingRecord {
  desktopKeyHash: string;
  deviceIdHash: string;
  tokenHash: string | null;
  desktopPubKey: string;
  fcmToken: string | null;
  updatedAtMs: number;
  lastDeliveredAtMs: number | null;
  certIssuedAt: number;
  certExpiresAt: number;
  certSignature: string;
}

interface CertificateOrdering {
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

interface WindowCounter {
  minute: number[];
  day: number[];
}

interface OrderedPairingMutationContext {
  transaction: Transaction;
  current: DocumentSnapshot;
  currentBinding: DocumentData | undefined;
  certificate: CertificateOrdering | null;
}

interface PushDeliveryTarget {
  token: string;
  tokenHash: string;
  accountDevices: QueryDocumentSnapshot[];
  anonymousBindings: QueryDocumentSnapshot[];
}

type PairingMutationAdmission = () => void;

const desktopPublishCounters = new Map<string, WindowCounter>();
const tokenPublishCounters = new Map<string, WindowCounter>();
const registrationCounters = new Map<string, number[]>();
const MAX_RATE_COUNTER_KEYS = 50_000;
const MAX_REGISTRATION_IPS = 10_000;

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const DESKTOP_PER_MINUTE = positiveIntegerEnv("KANNA_ANON_PUSH_DESKTOP_PER_MINUTE", 30);
const DESKTOP_PER_DAY = positiveIntegerEnv("KANNA_ANON_PUSH_DESKTOP_PER_DAY", 500);
const TOKEN_PER_MINUTE = positiveIntegerEnv("KANNA_ANON_PUSH_TOKEN_PER_MINUTE", 60);
const TOKEN_PER_DAY = positiveIntegerEnv("KANNA_ANON_PUSH_TOKEN_PER_DAY", 1_000);
const REGISTRATIONS_PER_IP_MINUTE = positiveIntegerEnv(
  "KANNA_ANON_PUSH_REGISTRATIONS_PER_IP_MINUTE",
  30,
);

export class AnonymousPushRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnonymousPushRefusal";
  }
}

export function anonymousDesktopId(publicKey: string): string {
  return sha256(publicKey);
}

export function consumePairingRequestLimit(
  address: string,
  method: "POST" | "DELETE",
  nowMs = Date.now(),
): boolean {
  const counterKey = `${method}:${address}`;
  if (!registrationCounters.has(counterKey) && registrationCounters.size >= MAX_REGISTRATION_IPS) {
    for (const [key, timestamps] of registrationCounters) {
      const retained = timestamps.filter((timestamp) => timestamp > nowMs - 60_000);
      if (retained.length === 0) registrationCounters.delete(key);
      else registrationCounters.set(key, retained);
    }
    if (registrationCounters.size >= MAX_REGISTRATION_IPS) {
      const oldest = registrationCounters.keys().next();
      if (!oldest.done) registrationCounters.delete(oldest.value);
    }
  }
  const current = registrationCounters.get(counterKey) ?? [];
  const retained = current.filter((timestamp) => timestamp > nowMs - 60_000);
  if (retained.length >= REGISTRATIONS_PER_IP_MINUTE) {
    registrationCounters.set(counterKey, retained);
    return false;
  }
  retained.push(nowMs);
  registrationCounters.set(counterKey, retained);
  return true;
}

export function createPairingRequestAdmission(
  address: string,
  method: "POST" | "DELETE",
  nowMs = Date.now(),
): PairingMutationAdmission {
  const admitted = consumePairingRequestLimit(address, method, nowMs);
  return () => {
    if (!admitted) {
      throw new AnonymousPushRefusal(
        429,
        "pairing_rate_limit",
        "Anonymous push pairing rate limit exceeded",
      );
    }
  };
}

export function verifyAnonymousSignature(
  desktopPubKey: string,
  payload: Uint8Array,
  signature: string,
): boolean {
  try {
    const rawKey = decodeBase64Url(desktopPubKey, 32);
    const rawSignature = decodeBase64Url(signature, 64);
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const key = createPublicKey({
      key: Buffer.concat([spkiPrefix, rawKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, payload, key, rawSignature);
  } catch {
    return false;
  }
}

export function anonymousAuthPayload(nonce: string): Buffer {
  return Buffer.concat([ANONYMOUS_AUTH_DOMAIN, decodeBase64Url(nonce, 32)]);
}

export function validateAnonymousPushPairing(
  value: unknown,
  nowMs?: number,
): AnonymousPushPairingRequest;
export function validateAnonymousPushPairing(
  value: unknown,
  nowMs: number,
  requireFcmToken: false,
): AnonymousPushPairingRevocation;
export function validateAnonymousPushPairing(
  value: unknown,
  nowMs = Date.now(),
  requireFcmToken = true,
): AnonymousPushPairingRequest | AnonymousPushPairingRevocation {
  if (!isRecord(value) || !isRecord(value.cert)) {
    throw new AnonymousPushRefusal(400, "malformed", "Anonymous push pairing is malformed");
  }
  const desktopPubKey = boundedText(value.desktopPubKey, 128);
  const deviceId = boundedText(value.deviceId, 256);
  const fcmToken = requireFcmToken ? boundedText(value.fcmToken, 4_096) : null;
  const certDeviceId = boundedText(value.cert.deviceId, 256);
  const issuedAt = safeInteger(value.cert.issuedAt);
  const expiresAt = safeInteger(value.cert.expiresAt);
  const signature = boundedText(value.cert.signature, 256);
  if (
    deviceId !== certDeviceId
    || issuedAt > nowMs + 5 * 60_000
    || expiresAt <= nowMs
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_CERTIFICATE_LIFETIME_MS
  ) {
    throw new AnonymousPushRefusal(401, "invalid_certificate", "Pairing certificate is invalid or expired");
  }
  const payload = Buffer.concat([
    PAIRING_CERT_DOMAIN,
    Buffer.from(JSON.stringify({ deviceId, issuedAt, expiresAt }), "utf8"),
  ]);
  if (!verifyAnonymousSignature(desktopPubKey, payload, signature)) {
    throw new AnonymousPushRefusal(401, "invalid_certificate", "Pairing certificate signature is invalid");
  }
  return {
    desktopPubKey,
    deviceId,
    ...(fcmToken ? { fcmToken } : {}),
    cert: { deviceId, issuedAt, expiresAt, signature },
  };
}

export async function registerAnonymousPushPairing(
  request: AnonymousPushPairingRequest,
  nowMs = Date.now(),
  db = getFirebaseServices().db,
  admit: PairingMutationAdmission = () => undefined,
): Promise<void> {
  await garbageCollectAnonymousPushPairings(db, nowMs);
  const desktopKeyHash = anonymousDesktopId(request.desktopPubKey);
  const deviceIdHash = sha256(request.deviceId);
  const tokenHash = sha256(request.fcmToken);
  const ref = db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
    .doc(`${desktopKeyHash}.${deviceIdHash}`);
  await mutateOrderedAnonymousPushPairing(ref, request.cert, db, admit, async ({
    transaction,
    currentBinding,
  }) => {
    const [desktopBindings, tokenBindings] = await Promise.all([
      transaction.get(db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
        .where("desktopKeyHash", "==", desktopKeyHash)),
      transaction.get(db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
        .where("tokenHash", "==", tokenHash)
        .limit(MAX_DESKTOPS_PER_TOKEN + 1)),
    ]);
    const activeDesktopBindingCount = desktopBindings.docs.filter((binding) =>
      typeof binding.data().fcmToken === "string" && binding.data().fcmToken.length > 0
    ).length;
    const existingIsActive = typeof currentBinding?.fcmToken === "string"
      && currentBinding.fcmToken.length > 0;
    if (!existingIsActive && activeDesktopBindingCount >= MAX_DEVICES_PER_DESKTOP) {
      throw new AnonymousPushRefusal(409, "desktop_binding_cap", "Desktop push pairing limit reached");
    }
    const sameTokenBinding = currentBinding?.tokenHash === tokenHash;
    if (!sameTokenBinding && tokenBindings.size >= MAX_DESKTOPS_PER_TOKEN) {
      throw new AnonymousPushRefusal(409, "token_binding_cap", "Push token pairing limit reached");
    }
    const record: AnonymousPushPairingRecord = {
      desktopKeyHash,
      deviceIdHash,
      tokenHash,
      desktopPubKey: request.desktopPubKey,
      fcmToken: request.fcmToken,
      updatedAtMs: nowMs,
      lastDeliveredAtMs: typeof currentBinding?.lastDeliveredAtMs === "number"
        ? currentBinding.lastDeliveredAtMs as number
        : null,
      certIssuedAt: request.cert.issuedAt,
      certExpiresAt: request.cert.expiresAt,
      certSignature: request.cert.signature,
    };
    transaction.set(ref, record);
  });
}

export async function revokeAnonymousPushPairing(
  request: AnonymousPushPairingRevocation,
  db = getFirebaseServices().db,
  admit: PairingMutationAdmission = () => undefined,
): Promise<void> {
  const ref = db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
    .doc(`${anonymousDesktopId(request.desktopPubKey)}.${sha256(request.deviceId)}`);
  await retireAnonymousPushPairing(ref, request.cert, Date.now(), db, undefined, admit);
}

export async function revokeAnonymousPushDevice(
  desktopPubKey: string,
  deviceId: string,
  db = getFirebaseServices().db,
): Promise<void> {
  const normalizedDeviceId = boundedText(deviceId, 256);
  const ref = db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
    .doc(`${anonymousDesktopId(desktopPubKey)}.${sha256(normalizedDeviceId)}`);
  await retireAnonymousPushPairing(ref, null, Date.now(), db);
}

export async function publishAnonymousPush(input: {
  desktopPubKey: string;
  userId?: string;
  desktopId?: string;
  notification: MobileNotification;
}, db = getFirebaseServices().db): Promise<MobileNotificationDelivery> {
  const nowMs = Date.now();
  const desktopKeyHash = anonymousDesktopId(input.desktopPubKey);
  const dualIdentity = Boolean(input.userId && input.desktopId);
  const anonymousAdmitted = consumeCounter(
    desktopPublishCounters,
    desktopKeyHash,
    nowMs,
    DESKTOP_PER_MINUTE,
    DESKTOP_PER_DAY,
  );
  if (!anonymousAdmitted && !dualIdentity) {
    throw new AnonymousPushRefusal(429, "desktop_rate_limit", "Anonymous desktop push rate limit exceeded");
  }
  const [anonymousSnapshot, accountSnapshot] = await Promise.all([
    anonymousAdmitted
      ? db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
        .where("desktopKeyHash", "==", desktopKeyHash)
        .get()
      : Promise.resolve(null),
    input.userId
      ? db.collection("users").doc(input.userId).collection("pushDevices")
        .limit(MAX_ACCOUNT_PUSH_DEVICES).get()
      : Promise.resolve(null),
  ]);
  const bindings = (anonymousSnapshot?.docs ?? [])
    .filter((doc) => isActiveBinding(doc, nowMs))
    .slice(0, MAX_DEVICES_PER_DESKTOP);
  if (bindings.length === 0 && !dualIdentity) {
    throw new AnonymousPushRefusal(409, "no_bindings", "No anonymous push pairings are registered");
  }

  const targets = new Map<string, PushDeliveryTarget>();
  for (const device of accountSnapshot?.docs ?? []) {
    const token = device.data().token;
    if (typeof token !== "string" || !token.trim()) continue;
    const normalized = token.trim();
    const target = targets.get(normalized) ?? {
      token: normalized,
      tokenHash: sha256(normalized),
      accountDevices: [],
      anonymousBindings: [],
    };
    target.accountDevices.push(device);
    targets.set(normalized, target);
  }
  for (const binding of bindings) {
    const token = binding.data().fcmToken;
    const tokenHash = binding.data().tokenHash;
    if (typeof token !== "string" || !token.trim() || typeof tokenHash !== "string") continue;
    const normalized = token.trim();
    const existing = targets.get(normalized);
    if (existing?.anonymousBindings.length) {
      existing.anonymousBindings.push(binding);
      continue;
    }
    if (!consumeCounter(tokenPublishCounters, tokenHash, nowMs, TOKEN_PER_MINUTE, TOKEN_PER_DAY)) {
      if (!dualIdentity) {
        throw new AnonymousPushRefusal(429, "token_rate_limit", "Anonymous push token rate limit exceeded");
      }
      continue;
    }
    const target = existing ?? {
      token: normalized,
      tokenHash,
      accountDevices: [],
      anonymousBindings: [],
    };
    target.anonymousBindings.push(binding);
    targets.set(normalized, target);
  }
  const { messaging } = getFirebaseServices();
  const selected = [...targets.values()];
  if (selected.length === 0) {
    return { acceptedCount: 0, failedCount: 0, failureReasons: [] };
  }
  const captureCollection = process.env.KANNA_E2E_ANON_PUSH_CAPTURE_COLLECTION?.trim();
  if (captureCollection) {
    const batch = db.batch();
    for (const target of selected) {
      batch.set(db.collection(captureCollection).doc(), {
        desktopKeyHash,
        desktopRoutingId: input.desktopId ?? input.desktopPubKey,
        tokenHash: target.tokenHash,
        notification: input.notification,
        capturedAtMs: nowMs,
      });
      for (const binding of target.anonymousBindings) {
        batch.update(binding.ref, { lastDeliveredAtMs: nowMs });
      }
    }
    await batch.commit();
    return {
      acceptedCount: selected.length,
      failedCount: 0,
      failureReasons: [],
    };
  }
  const response = await messaging.sendEachForMulticast({
    tokens: selected.map((target) => target.token),
    notification: { title: input.notification.title, body: input.notification.body },
    data: {
      kannaNotificationVersion: "1",
      kind: input.notification.taskId ? "task" : "general",
      // Dual-identity sessions retain the account-authoritative desktop id.
      // Anonymous-only sessions use the proven public key, which the phone
      // maps back to its locally paired desktop.
      desktopId: input.desktopId ?? input.desktopPubKey,
      ...(input.notification.taskId ? { taskId: input.notification.taskId } : {}),
    },
    apns: { payload: { aps: { sound: "default" } } },
  });
  await Promise.allSettled(response.responses.map(async (result, index) => {
    const target = selected[index];
    if (!target) return;
    if (result.success) {
      await Promise.all(target.anonymousBindings.map((binding) =>
        binding.ref.update({ lastDeliveredAtMs: nowMs })));
    } else if (result.error?.code && INVALID_TOKEN_CODES.has(result.error.code)) {
      await Promise.all([
        ...target.anonymousBindings.map((binding) =>
          reconcileInvalidAnonymousPushToken(binding, nowMs, db)),
        ...target.accountDevices.map((device) => db.runTransaction(async (transaction) => {
          const current = await transaction.get(device.ref);
          if (current.data()?.token === target.token) transaction.delete(device.ref);
        })),
      ]);
    }
  }));
  return {
    acceptedCount: response.successCount,
    failedCount: response.failureCount,
    failureReasons: summarizeFailures(
      response.responses.flatMap((result) => result.error ? [result.error] : []),
    ),
  };
}

export async function reconcileInvalidAnonymousPushToken(
  binding: QueryDocumentSnapshot,
  nowMs = Date.now(),
  db = getFirebaseServices().db,
): Promise<void> {
  await retireAnonymousPushPairing(
    binding.ref,
    storedCertificate(binding.data()),
    nowMs,
    db,
  );
}

export async function garbageCollectAnonymousPushPairings(
  db: Firestore,
  nowMs = Date.now(),
): Promise<number> {
  const stale = await db.collection(ANONYMOUS_PUSH_PAIRINGS_COLLECTION)
    .where("updatedAtMs", "<", nowMs - STALE_BINDING_MS)
    .limit(100)
    .get();
  const expired = stale.docs.filter((doc) => {
    const lastDelivered = doc.data().lastDeliveredAtMs;
    return typeof lastDelivered !== "number" || lastDelivered < nowMs - STALE_BINDING_MS;
  });
  if (expired.length === 0) return 0;
  const results = await Promise.all(expired.map(async (doc) => {
    try {
      return await retireAnonymousPushPairing(
        doc.ref,
        storedCertificate(doc.data()),
        nowMs,
        db,
        nowMs - STALE_BINDING_MS,
      );
    } catch (error) {
      if (error instanceof AnonymousPushRefusal && error.code === "stale_certificate") return false;
      throw error;
    }
  }));
  return results.filter(Boolean).length;
}

async function retireAnonymousPushPairing(
  ref: DocumentReference,
  candidate: CertificateOrdering | null,
  nowMs: number,
  db: Firestore,
  staleBeforeMs?: number,
  admit: PairingMutationAdmission = () => undefined,
): Promise<boolean> {
  return mutateOrderedAnonymousPushPairing(ref, candidate, db, admit, ({
    transaction,
    current,
    currentBinding,
    certificate,
  }) => {
    if (!current.exists) return false;
    if (!currentBinding) throw new Error("Anonymous push pairing has no data");
    if (!certificate) throw new Error("Anonymous push pairing has no certificate ordering metadata");
    if (staleBeforeMs !== undefined) {
      const updatedAtMs = currentBinding.updatedAtMs;
      const lastDeliveredAtMs = currentBinding.lastDeliveredAtMs;
      if (
        typeof updatedAtMs !== "number"
        || updatedAtMs >= staleBeforeMs
        || (typeof lastDeliveredAtMs === "number" && lastDeliveredAtMs >= staleBeforeMs)
      ) {
        return false;
      }
    }
    if (certificate.issuedAt + MAX_CERTIFICATE_LIFETIME_MS <= nowMs) transaction.delete(ref);
    else transaction.set(ref, revokedPairingRecord(currentBinding, certificate, nowMs));
    return true;
  });
}

async function mutateOrderedAnonymousPushPairing<T>(
  ref: DocumentReference,
  candidate: CertificateOrdering | null,
  db: Firestore,
  admit: PairingMutationAdmission,
  mutate: (context: OrderedPairingMutationContext) => T | Promise<T>,
): Promise<T> {
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    const currentBinding = current.data();
    const certificate = candidate ?? (currentBinding ? storedCertificate(currentBinding) : null);
    if (certificate) assertCurrentOrNewerCertificate(certificate, currentBinding);
    admit();
    return mutate({ transaction, current, currentBinding, certificate });
  });
}

function assertCurrentOrNewerCertificate(
  candidate: CertificateOrdering,
  currentBinding: DocumentData | undefined,
): void {
  if (typeof currentBinding?.certIssuedAt !== "number") return;
  if (
    candidate.issuedAt < currentBinding.certIssuedAt
    || (
      candidate.issuedAt === currentBinding.certIssuedAt
      && candidate.signature !== currentBinding.certSignature
    )
  ) {
    throw new AnonymousPushRefusal(
      409,
      "stale_certificate",
      "A newer anonymous push pairing is registered",
    );
  }
}

function storedCertificate(currentBinding: DocumentData): CertificateOrdering {
  const issuedAt = currentBinding.certIssuedAt;
  const expiresAt = currentBinding.certExpiresAt;
  const signature = currentBinding.certSignature;
  if (
    typeof issuedAt !== "number"
    || typeof signature !== "string"
    || (typeof expiresAt !== "number" && expiresAt !== undefined)
  ) {
    throw new Error("Anonymous push pairing has invalid certificate ordering metadata");
  }
  return {
    issuedAt,
    // Pre-ordering records did not retain expiry. Their issuance time still
    // bounds every certificate that could be older than this watermark.
    expiresAt: typeof expiresAt === "number" ? expiresAt : issuedAt + MAX_CERTIFICATE_LIFETIME_MS,
    signature,
  };
}

function revokedPairingRecord(
  currentBinding: DocumentData,
  certificate: CertificateOrdering,
  nowMs: number,
): AnonymousPushPairingRecord {
  return {
    desktopKeyHash: currentBinding.desktopKeyHash as string,
    deviceIdHash: currentBinding.deviceIdHash as string,
    tokenHash: null,
    desktopPubKey: currentBinding.desktopPubKey as string,
    fcmToken: null,
    updatedAtMs: nowMs,
    lastDeliveredAtMs: typeof currentBinding.lastDeliveredAtMs === "number"
      ? currentBinding.lastDeliveredAtMs
      : null,
    certIssuedAt: certificate.issuedAt,
    certExpiresAt: certificate.expiresAt,
    certSignature: certificate.signature,
  };
}

function isActiveBinding(doc: QueryDocumentSnapshot, nowMs: number): boolean {
  const data = doc.data();
  return typeof data.fcmToken === "string"
    && data.fcmToken.length > 0
    && typeof data.updatedAtMs === "number"
    && (data.updatedAtMs >= nowMs - STALE_BINDING_MS
      || (typeof data.lastDeliveredAtMs === "number"
        && data.lastDeliveredAtMs >= nowMs - STALE_BINDING_MS));
}

function consumeCounter(
  counters: Map<string, WindowCounter>,
  key: string,
  nowMs: number,
  minuteLimit: number,
  dayLimit: number,
): boolean {
  if (!counters.has(key) && counters.size >= MAX_RATE_COUNTER_KEYS) {
    for (const [candidateKey, candidate] of counters) {
      candidate.minute = candidate.minute.filter((timestamp) => timestamp > nowMs - 60_000);
      candidate.day = candidate.day.filter((timestamp) => timestamp > nowMs - 24 * 60 * 60_000);
      if (candidate.day.length === 0) counters.delete(candidateKey);
    }
    if (counters.size >= MAX_RATE_COUNTER_KEYS) {
      const oldest = counters.keys().next();
      if (!oldest.done) counters.delete(oldest.value);
    }
  }
  const counter = counters.get(key) ?? { minute: [], day: [] };
  counter.minute = counter.minute.filter((timestamp) => timestamp > nowMs - 60_000);
  counter.day = counter.day.filter((timestamp) => timestamp > nowMs - 24 * 60 * 60_000);
  if (counter.minute.length >= minuteLimit || counter.day.length >= dayLimit) {
    counters.set(key, counter);
    return false;
  }
  counter.minute.push(nowMs);
  counter.day.push(nowMs);
  counters.set(key, counter);
  return true;
}

function summarizeFailures(errors: readonly { code: string; message: string }[]) {
  const summaries = new Map<string, ReturnType<typeof diagnoseMessagingFailure>>();
  for (const error of errors) {
    const reason = diagnoseMessagingFailure(error);
    const key = `${reason.category}:${reason.providerCode}`;
    const current = summaries.get(key);
    if (current) current.count += 1;
    else summaries.set(key, reason);
  }
  return [...summaries.values()];
}

function decodeBase64Url(value: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedLength) throw new Error("invalid length");
  return decoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new AnonymousPushRefusal(400, "malformed", "Anonymous push pairing is malformed");
  }
  return value.trim();
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnonymousPushRefusal(400, "malformed", "Anonymous push pairing is malformed");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
