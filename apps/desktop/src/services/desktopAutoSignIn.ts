import type { DesktopAuthSession, DesktopAuthState } from "./desktopAuth";

export interface DesktopAutoSignInOptions {
  dev: boolean;
  session: DesktopAuthSession;
  getState: () => DesktopAuthState;
  readEnv: (name: string) => Promise<string>;
}

const attemptedSessions = new WeakSet<DesktopAuthSession>();

export async function runDesktopAutoSignIn({
  dev,
  session,
  getState,
  readEnv,
}: DesktopAutoSignInOptions): Promise<void> {
  if (!dev || attemptedSessions.has(session) || getState().status !== "signedOut") return;

  const cloudEnv = normalizeEnv(await readOptionalEnv(readEnv, "KANNA_CLOUD_ENV"));
  if (cloudEnv !== "staging") return;

  const [email, password] = await Promise.all([
    readOptionalEnv(readEnv, "KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL"),
    readOptionalEnv(readEnv, "KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD"),
  ]);
  const normalizedEmail = normalizeEnv(email);
  const normalizedPassword = normalizeEnv(password);
  if (!normalizedEmail || !normalizedPassword || getState().status !== "signedOut") return;

  attemptedSessions.add(session);
  try {
    await session.signInWithEmailPassword({
      email: normalizedEmail,
      password: normalizedPassword,
    });
  } catch (error) {
    console.warn("[cloud] desktop auto sign-in failed:", error);
  }
}

async function readOptionalEnv(
  readEnv: DesktopAutoSignInOptions["readEnv"],
  name: string,
): Promise<string | undefined> {
  try {
    return await readEnv(name);
  } catch {
    return undefined;
  }
}

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
