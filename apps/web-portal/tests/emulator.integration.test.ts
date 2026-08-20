import { beforeAll, describe, expect, it } from "vitest";
import { applyActionCode } from "firebase/auth";
import { auth, portalFirebase } from "../src/firebase";

const run = process.env.KANNA_RUN_WEB_PORTAL_EMULATOR_INTEGRATION === "1";
const integration = run ? describe : describe.skip;
const projectId = "kanna-local";
const authPort = process.env.KANNA_FIREBASE_AUTH_PORT || process.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099";

interface OutOfBandCode {
  email: string;
  oobCode: string;
  requestType: string;
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

    const codesResponse = await fetch(`http://127.0.0.1:${authPort}/emulator/v1/projects/${projectId}/oobCodes`);
    const codes = await codesResponse.json() as { oobCodes: OutOfBandCode[] };
    const verification = codes.oobCodes.find((code) => code.email === email && code.requestType === "VERIFY_EMAIL");
    expect(verification).toBeDefined();
    if (!verification) throw new Error("Auth emulator did not create an email verification code");
    await applyActionCode(auth, verification.oobCode);

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
