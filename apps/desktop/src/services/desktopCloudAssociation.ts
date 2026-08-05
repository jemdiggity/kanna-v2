import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { invoke } from "../invoke";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { DesktopCloudCredentialConflictError } from "./desktopCloudCredentialConflict";
import { getConfiguredDesktopFirestore } from "./desktopCloudTaskIndex";
import { reconnectDesktopCloudRelay } from "./desktopServerClient";

const GENERIC_DESKTOP_NAME = "Kanna Desktop";

interface DesktopCloudCredentialPayload {
  desktopId?: string;
  desktopSecretHash?: string;
}

export async function associateDesktopCloudCredential(): Promise<void> {
  const [session, firestore, credential, status] = await Promise.all([
    getConfiguredDesktopAuthSession(),
    getConfiguredDesktopFirestore(),
    invoke<DesktopCloudCredentialPayload>("desktop_cloud_credential").catch(() => null),
    invoke<{ desktopName?: string }>("mobile_server_status").catch(() => null),
  ]);
  const auth = session.getState();
  if (auth.status !== "signedIn" || !firestore) return;
  const desktopId = normalizeRequired(credential?.desktopId);
  const desktopSecretHash = normalizeRequired(credential?.desktopSecretHash);
  if (!desktopId || !desktopSecretHash) return;

  const displayName = normalizeDesktopName(status?.desktopName)
    || await fallbackDesktopName();
  const writes: Promise<void>[] = [
    asCredentialConflict(
      desktopId,
      setDoc(doc(firestore, "desktopCredentials", desktopDocumentId(desktopId)), {
        desktopId,
        desktopSecretHash,
        displayName,
        revokedAt: null,
        uid: auth.user.uid,
        updatedAt: serverTimestamp(),
      }, { merge: true }),
    ),
  ];
  if (auth.user.email) {
    writes.push(setDoc(doc(firestore, "users", auth.user.uid), {
      primaryEmail: auth.user.email,
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  }
  await Promise.all(writes);
}

/**
 * Releases this desktop so another account can claim it. Unlike association,
 * which runs on every sign-in and may legitimately find nothing to do yet, this
 * runs once at sign-out and is the only thing that ever clears the claim — a
 * silent no-op here strands the machine on the account being left, and the next
 * account is refused by the rules with no way back. So every reason it cannot
 * write is raised, not swallowed.
 */
export async function revokeDesktopCloudCredential(): Promise<void> {
  const [session, firestore, credential, status] = await Promise.all([
    getConfiguredDesktopAuthSession(),
    getConfiguredDesktopFirestore(),
    invoke<DesktopCloudCredentialPayload>("desktop_cloud_credential"),
    invoke<{ desktopName?: string }>("mobile_server_status").catch(() => null),
  ]);
  const auth = session.getState();
  if (auth.status !== "signedIn") {
    throw new Error("cannot release this desktop while signed out");
  }
  if (!firestore) {
    throw new Error("cannot release this desktop: cloud access is not configured");
  }
  const desktopId = normalizeRequired(credential?.desktopId);
  const desktopSecretHash = normalizeRequired(credential?.desktopSecretHash);
  if (!desktopId || !desktopSecretHash) {
    throw new Error("cannot release this desktop: its local credential is unavailable");
  }

  const displayName = normalizeDesktopName(status?.desktopName)
    || await fallbackDesktopName();

  await asCredentialConflict(
    desktopId,
    setDoc(doc(firestore, "desktopCredentials", desktopDocumentId(desktopId)), {
      desktopId,
      desktopSecretHash,
      displayName,
      revokedAt: serverTimestamp(),
      uid: auth.user.uid,
      updatedAt: serverTimestamp(),
    }, { merge: true }),
  );
  await reconnectDesktopCloudRelay();
}

/**
 * The credential payload is built here, so it always satisfies the rules'
 * shape, id, and self-consistency checks. That leaves the ownership branch as
 * the only way a well-formed write can be denied: another account holds this
 * desktop's document and has not revoked it.
 */
async function asCredentialConflict(desktopId: string, write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch (error) {
    if (isPermissionDenied(error)) {
      throw new DesktopCloudCredentialConflictError(desktopId, { cause: error });
    }
    throw error;
  }
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "permission-denied";
}

function desktopDocumentId(desktopId: string): string {
  if (desktopId === "." || desktopId === "..") {
    return `desktop-${desktopId === "." ? "2e" : "2e2e"}`;
  }
  return desktopId.replace(/\//g, "_");
}

function normalizeRequired(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDesktopName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim();
  return name === GENERIC_DESKTOP_NAME ? "" : name;
}

async function fallbackDesktopName(): Promise<string> {
  for (const name of ["HOSTNAME", "COMPUTERNAME"]) {
    const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return GENERIC_DESKTOP_NAME;
}
