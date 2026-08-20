import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyActionCode } from "firebase/auth";
import { auth, portalFirebase } from "../src/firebase";

const run = process.env.KANNA_RUN_WEB_PORTAL_EMULATOR_INTEGRATION === "1";
const integration = run ? describe : describe.skip;
const projectId = "kanna-local";
const authPort = process.env.KANNA_FIREBASE_AUTH_PORT || process.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099";
const functionsPort = Number(process.env.KANNA_FIREBASE_FUNCTIONS_PORT || process.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || "5001");

interface OutOfBandCode {
  email: string;
  oobCode: string;
  requestType: string;
}

interface FirebaseTokenPayload {
  email_verified?: boolean;
  user_id?: string;
}

function tokenPayload(authorization: string | undefined): FirebaseTokenPayload | null {
  const bearerToken = authorization?.match(/^Bearer (.+)$/)?.[1];
  const token = bearerToken?.split(".")[1];
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as FirebaseTokenPayload;
  } catch {
    return null;
  }
}

function startCheckoutCallableStub(): Promise<Server> {
  // Test-only callable protocol stub. The billing task's real exported function
  // replaces this server when its implementation lands in the emulator suite.
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    const token = tokenPayload(request.headers.authorization);
    if (!token?.user_id) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { status: "UNAUTHENTICATED", message: "Authentication required" } }));
      return;
    }
    if (token.email_verified !== true) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "Verified email required" } }));
      return;
    }
    response.end(JSON.stringify({
      data: {
        url: "https://checkout.stripe.test/session/cs_test_portal"
      }
    }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(functionsPort, "127.0.0.1", () => resolve(server));
  });
}

integration("web portal Firebase emulator flow", () => {
  const email = `portal-${Date.now()}@example.test`;
  const password = "correct-horse-battery-staple";

  let checkoutCallableStub: Server;

  beforeAll(async () => {
    checkoutCallableStub = await startCheckoutCallableStub();
    await fetch(`http://127.0.0.1:${authPort}/emulator/v1/projects/${projectId}/accounts`, { method: "DELETE" });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      checkoutCallableStub.close((error) => error ? reject(error) : resolve());
    });
  });

  it("registers, verifies, signs in, and invokes createCheckoutSession", async () => {
    await expect(portalFirebase.createCheckoutSession({
      successUrl: "http://localhost/checkout/success",
      cancelUrl: "http://localhost/checkout/cancelled"
    })).rejects.toMatchObject({ code: "functions/unauthenticated" });

    const registered = await portalFirebase.register(email, password);
    expect(registered.emailVerified).toBe(false);

    await expect(portalFirebase.createCheckoutSession({
      successUrl: "http://localhost/checkout/success",
      cancelUrl: "http://localhost/checkout/cancelled"
    })).rejects.toMatchObject({ code: "functions/failed-precondition" });

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
