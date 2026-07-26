import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { invoke } from "../invoke";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
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
    setDoc(doc(firestore, "desktopCredentials", desktopDocumentId(desktopId)), {
      desktopId,
      desktopSecretHash,
      displayName,
      revokedAt: null,
      uid: auth.user.uid,
      updatedAt: serverTimestamp(),
    }, { merge: true }),
  ];
  if (auth.user.email) {
    writes.push(setDoc(doc(firestore, "users", auth.user.uid), {
      primaryEmail: auth.user.email,
      updatedAt: serverTimestamp(),
    }, { merge: true }));
  }
  await Promise.all(writes);
}

export async function revokeDesktopCloudCredential(): Promise<void> {
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

  await setDoc(doc(firestore, "desktopCredentials", desktopDocumentId(desktopId)), {
    desktopId,
    desktopSecretHash,
    displayName,
    revokedAt: serverTimestamp(),
    uid: auth.user.uid,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await reconnectDesktopCloudRelay();
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
