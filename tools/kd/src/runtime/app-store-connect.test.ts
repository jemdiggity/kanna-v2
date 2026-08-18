import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppStoreConnectClient,
  appStoreConnectPrivateKeyPath,
  createAppStoreConnectJwt,
  highestBuildNumber,
  parseReleaseType,
  resolveAppStoreConnectCredentials,
  type AppStoreConnectHttpRequest,
  type AppStoreConnectHttpRunner
} from "./app-store-connect";

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

const CREDENTIALS = {
  keyId: "ABCD1234EF",
  issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1",
  privateKey
};

const FIXED_NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  ) as Record<string, unknown>;
}

/** Records every request and answers from a table keyed by pathname. */
function stubHttp(
  responses: Record<string, { status?: number; body: unknown }>,
  calls: AppStoreConnectHttpRequest[] = []
): AppStoreConnectHttpRunner {
  return {
    async request(input) {
      calls.push(input);
      const { pathname } = new URL(input.url);
      const match = responses[pathname];
      if (!match) {
        return { status: 404, body: JSON.stringify({ errors: [{ title: "Not Found" }] }) };
      }
      return {
        status: match.status ?? 200,
        body: typeof match.body === "string" ? match.body : JSON.stringify(match.body)
      };
    }
  };
}

function client(
  responses: Record<string, { status?: number; body: unknown }>,
  calls: AppStoreConnectHttpRequest[] = []
): AppStoreConnectClient {
  return new AppStoreConnectClient({
    credentials: CREDENTIALS,
    http: stubHttp(responses, calls),
    now: () => FIXED_NOW
  });
}

describe("App Store Connect JWT", () => {
  it("signs an ES256 token Apple accepts", () => {
    const token = createAppStoreConnectJwt(CREDENTIALS, FIXED_NOW);
    const [header, payload, signature] = token.split(".");

    expect(decodeSegment(header)).toEqual({ alg: "ES256", kid: CREDENTIALS.keyId, typ: "JWT" });
    expect(decodeSegment(payload)).toEqual({
      iss: CREDENTIALS.issuerId,
      iat: FIXED_NOW / 1000,
      exp: FIXED_NOW / 1000 + 900,
      aud: "appstoreconnect-v1"
    });
    // JOSE (ieee-p1363) encoding is r||s over P-256: exactly 64 bytes. Node's
    // default DER encoding is variable-length and Apple rejects it with a 401.
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
  });

  it("keeps the token inside Apple's 20 minute lifetime cap", () => {
    const payload = decodeSegment(createAppStoreConnectJwt(CREDENTIALS, FIXED_NOW).split(".")[1]);

    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(20 * 60);
  });
});

describe("App Store Connect credentials", () => {
  it("resolves the key path from the key id", () => {
    expect(appStoreConnectPrivateKeyPath("ABCD1234EF", "/Users/example")).toBe(
      "/Users/example/.appstoreconnect/private_keys/AuthKey_ABCD1234EF.p8"
    );
  });

  it("names both environment variables when either is missing", async () => {
    await expect(resolveAppStoreConnectCredentials({})).rejects.toThrow(
      "APP_STORE_CONNECT_API_KEY_ID and APP_STORE_CONNECT_API_ISSUER_ID"
    );
    await expect(
      resolveAppStoreConnectCredentials({ APP_STORE_CONNECT_API_KEY_ID: "ABCD1234EF" })
    ).rejects.toThrow("APP_STORE_CONNECT_API_ISSUER_ID");
  });

  it("names the missing private key path", async () => {
    await expect(
      resolveAppStoreConnectCredentials(
        {
          APP_STORE_CONNECT_API_KEY_ID: "ABCD1234EF",
          APP_STORE_CONNECT_API_ISSUER_ID: "issuer"
        },
        { home: "/nonexistent-home" }
      )
    ).rejects.toThrow("/nonexistent-home/.appstoreconnect/private_keys/AuthKey_ABCD1234EF.p8");
  });
});

describe("App Store Connect client", () => {
  it("sends a bearer token and pins the bundle id exactly", async () => {
    const calls: AppStoreConnectHttpRequest[] = [];
    const asc = client(
      {
        "/v1/apps": {
          body: {
            data: [
              { id: "111", attributes: { bundleId: "build.kanna.app.staging" } },
              { id: "222", attributes: { bundleId: "build.kanna.app" } }
            ]
          }
        }
      },
      calls
    );

    // Apple's bundleId filter is a prefix match, so the staging id comes back too.
    expect(await asc.findAppId("build.kanna.app")).toBe("222");
    expect(calls[0]?.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[0]?.url).toContain("filter%5BbundleId%5D=build.kanna.app");
  });

  it("fails with a readable error when the app is not visible to the key", async () => {
    const asc = client({ "/v1/apps": { body: { data: [] } } });

    await expect(asc.findAppId("build.kanna.app")).rejects.toThrow(
      "no app with bundle id build.kanna.app visible to this API key"
    );
  });

  it("surfaces Apple's error titles rather than a bare status", async () => {
    const asc = client({
      "/v1/apps": {
        status: 401,
        body: { errors: [{ title: "NOT_AUTHORIZED", detail: "Authentication credentials are missing" }] }
      }
    });

    await expect(asc.findAppId("build.kanna.app")).rejects.toThrow(
      "NOT_AUTHORIZED: Authentication credentials are missing"
    );
  });

  it("lists and finds builds for a marketing version", async () => {
    const calls: AppStoreConnectHttpRequest[] = [];
    const asc = client(
      {
        "/v1/builds": {
          body: {
            data: [
              { id: "b1", attributes: { version: "1", processingState: "VALID" } },
              { id: "b2", attributes: { version: "2", processingState: "PROCESSING" } }
            ]
          }
        }
      },
      calls
    );

    expect(await asc.listBuilds({ appId: "222", version: "1.0.0" })).toEqual([
      { id: "b1", version: "1", processingState: "VALID", uploadedDate: undefined },
      { id: "b2", version: "2", processingState: "PROCESSING", uploadedDate: undefined }
    ]);
    expect(calls[0]?.url).toContain("filter%5BpreReleaseVersion.version%5D=1.0.0");
    expect(await asc.findBuild({ appId: "222", version: "1.0.0", buildNumber: "2" })).toMatchObject({
      id: "b2",
      processingState: "PROCESSING"
    });
    expect(
      await asc.findBuild({ appId: "222", version: "1.0.0", buildNumber: "9" })
    ).toBeNull();
  });

  it("finds the App Store version and attaches a build to it", async () => {
    const calls: AppStoreConnectHttpRequest[] = [];
    const asc = client(
      {
        "/v1/apps/222/appStoreVersions": {
          body: {
            data: [
              { id: "v9", attributes: { versionString: "1.0.0", appStoreState: "PREPARE_FOR_SUBMISSION" } }
            ]
          }
        },
        "/v1/appStoreVersions/v9/relationships/build": { status: 204, body: "" },
        "/v1/appStoreVersions/v9": { status: 204, body: "" }
      },
      calls
    );

    const version = await asc.findAppStoreVersion({ appId: "222", version: "1.0.0" });
    expect(version).toMatchObject({ id: "v9", appStoreState: "PREPARE_FOR_SUBMISSION" });

    await asc.attachBuildToAppStoreVersion({ appStoreVersionId: "v9", buildId: "b2" });
    const attach = calls[1];
    expect(attach?.method).toBe("PATCH");
    expect(JSON.parse(attach?.body ?? "{}")).toEqual({ data: { type: "builds", id: "b2" } });

    await asc.setReleaseType({ appStoreVersionId: "v9", releaseType: "MANUAL" });
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      data: {
        type: "appStoreVersions",
        id: "v9",
        attributes: { releaseType: "MANUAL" }
      }
    });
  });

  it("returns null when the App Store version does not exist yet", async () => {
    const asc = client({ "/v1/apps/222/appStoreVersions": { body: { data: [] } } });

    expect(await asc.findAppStoreVersion({ appId: "222", version: "1.0.0" })).toBeNull();
  });
});

describe("build number arithmetic", () => {
  it("compares build numbers numerically, not as strings", () => {
    expect(
      highestBuildNumber([
        { id: "a", version: "9", processingState: "VALID" },
        { id: "b", version: "10", processingState: "VALID" }
      ])
    ).toBe(10);
    expect(highestBuildNumber([])).toBe(0);
    expect(
      highestBuildNumber([{ id: "a", version: "not-a-number", processingState: "VALID" }])
    ).toBe(0);
  });
});

describe("release type", () => {
  it("accepts Apple's vocabulary and rejects anything else", () => {
    expect(parseReleaseType("manual")).toBe("MANUAL");
    expect(parseReleaseType("after-approval")).toBe("AFTER_APPROVAL");
    expect(parseReleaseType(" SCHEDULED ")).toBe("SCHEDULED");
    expect(() => parseReleaseType("immediately")).toThrow(
      "--release-type must be one of MANUAL, AFTER_APPROVAL, SCHEDULED"
    );
  });
});
