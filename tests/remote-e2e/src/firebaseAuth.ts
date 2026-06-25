import { setTimeout as sleep } from "node:timers/promises";

export const BUFFY_EMAIL = "upvote.sieve.7t@icloud.com";
export const BUFFY_PASSWORD = "password123";
export const BUFFY_UID = "Bax9TJvOWm5bbl0Aq4nXg3XmkTCu";

interface SignInResponse {
  idToken?: string;
  localId?: string;
}

export async function signInWithPassword(input: {
  authPort: number;
  email: string;
  password: string;
}): Promise<SignInResponse | null> {
  const url = `http://127.0.0.1:${input.authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      returnSecureToken: true
    })
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return await response.json().catch(() => null) as SignInResponse | null;
}

export async function waitForBuffyIdToken(authPort: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const signIn = await signInWithPassword({
      authPort,
      email: BUFFY_EMAIL,
      password: BUFFY_PASSWORD
    });
    if (signIn?.idToken) {
      if (signIn.localId && signIn.localId !== BUFFY_UID) {
        throw new Error(`Buffy auth seed resolved unexpected uid ${signIn.localId}`);
      }
      return signIn.idToken;
    }
    await sleep(250);
  }
  throw new Error(`Firebase Auth emulator did not accept Buffy credentials on ${authPort}`);
}
