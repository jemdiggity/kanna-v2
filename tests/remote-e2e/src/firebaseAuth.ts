import { setTimeout as sleep } from "node:timers/promises";

export const BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
export const BUFFY_PASSWORD = "password123";
export const BUFFY_UID = "Bax9TJvOWm5bbl0Aq4nXg3XmkTCu";

export interface SignInOutcome {
  idToken?: string;
  localId?: string;
  /**
   * Why the emulator did not return a token; absent on success.
   *
   * This exists because the seeding failure it describes has cost hours three
   * separate times: the emulator's own rejection — a 400 with
   * `EMAIL_NOT_FOUND`, a connection refused, an emulator that imported no seed
   * — was collapsed into `null` at the call site, so every caller could only
   * report "did not accept the credentials" without saying what the emulator
   * actually said.
   */
  failure?: string;
}

export async function signInWithPassword(input: {
  authPort: number;
  email: string;
  password: string;
}): Promise<SignInOutcome> {
  const url = `http://127.0.0.1:${input.authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      returnSecureToken: true
    })
  }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

  if (response instanceof Error) {
    return { failure: `${response.message} (POST ${url})` };
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { failure: `${response.status} ${response.statusText}: ${body.trim() || "<empty body>"}` };
  }

  const parsed = parseJson(body);
  if (!parsed) {
    return { failure: `${response.status} returned unparseable body: ${body.slice(0, 400)}` };
  }
  if (!parsed.idToken) {
    return { failure: `${response.status} returned no idToken: ${body.slice(0, 400)}` };
  }
  return parsed;
}

function parseJson(body: string): SignInOutcome | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as SignInOutcome : null;
  } catch {
    return null;
  }
}

/**
 * Waits for the Auth emulator to accept the seeded Buffy account.
 *
 * The wait is expected — the emulator answers before it has finished importing
 * `services/firebase/emulator-seed` — but a wait that ends in a timeout is not
 * "the emulator is slow", it is a seeding failure with a reason. So the reason
 * the last attempt gave travels into the timeout, together with where the
 * emulator writes its own account of the same event.
 */
export async function waitForBuffyIdToken(
  authPort: number,
  timeoutMs: number,
  options: { logDirectory?: string } = {}
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no attempt completed";
  while (Date.now() < deadline) {
    const signIn = await signInWithPassword({
      authPort,
      email: BUFFY_EMAIL,
      password: BUFFY_PASSWORD
    });
    if (signIn.idToken) {
      if (signIn.localId && signIn.localId !== BUFFY_UID) {
        throw new Error(`Buffy auth seed resolved unexpected uid ${signIn.localId}`);
      }
      return signIn.idToken;
    }
    lastFailure = signIn.failure ?? "sign-in returned no token and no reason";
    await sleep(250);
  }
  const logs = options.logDirectory
    ? ` The emulator's own account of this is in ${options.logDirectory}/firebase-debug.log ` +
      `(auth emulator seed: services/firebase/emulator-seed).`
    : "";
  throw new Error(
    `Firebase Auth emulator did not accept Buffy credentials on ${authPort} within ${timeoutMs}ms. ` +
      `Last emulator response: ${lastFailure}.${logs}`
  );
}
