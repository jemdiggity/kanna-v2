import { beforeAll, describe, expect, it } from "vitest";
import { portalFirebase } from "../src/firebase";

const run = process.env.KANNA_RUN_WEB_PORTAL_EMULATOR_INTEGRATION === "1";
const integration = run ? describe : describe.skip;
const projectId = "kanna-local";
const authPort = process.env.FIREBASE_AUTH_EMULATOR_PORT || "9099";

interface EmulatorUser {
  localId: string;
}

integration("web portal Firebase emulator flow", () => {
  const email = `portal-${Date.now()}@example.test`;
  const password = "correct-horse-battery-staple";

  beforeAll(async () => {
    await fetch(`http://127.0.0.1:${authPort}/emulator/v1/projects/${projectId}/accounts`, { method: "DELETE" });
  });

  it("registers, verifies, signs in, and invokes createCheckoutSession", async () => {
    const registered = await portalFirebase.register(email, password);
    expect(registered.emailVerified).toBe(false);

    const usersResponse = await fetch(`http://127.0.0.1:${authPort}/emulator/v1/projects/${projectId}/accounts`);
    const users = await usersResponse.json() as { users: EmulatorUser[] };
    const localId = users.users.find((candidate) => candidate.localId === registered.uid)?.localId;
    expect(localId).toBe(registered.uid);
    await fetch(`http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake-api-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localId, emailVerified: true })
    });

    await portalFirebase.signOut();
    const signedIn = await portalFirebase.signIn(email, password);
    expect(signedIn.emailVerified).toBe(true);

    const checkout = await portalFirebase.createCheckoutSession({
      successUrl: "http://localhost/checkout/success",
      cancelUrl: "http://localhost/checkout/cancelled"
    });
    expect(checkout.url).toMatch(/^https?:\/\//);
    // Redirect is deliberately outside this integration boundary; component tests mock it.
  });
});
