import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCloudTestCredentialEnv,
  applyProductionCloudEnv,
  cloudTestCredsPath,
  parseCloudTestCreds,
  readCloudTestCredentials,
} from "../src/runtime/cloud-creds";

describe("cloud test credentials", () => {
  it("resolves the creds path under ~/.kanna/dev", () => {
    expect(cloudTestCredsPath("/Users/example")).toBe("/Users/example/.kanna/dev/creds.toml");
  });

  it("parses a cloud_test_user table", () => {
    const creds = parseCloudTestCreds(
      '[cloud_test_user]\nemail = "user@example.com"\npassword = "hunter22"\n',
    );
    expect(creds).toEqual({ email: "user@example.com", password: "hunter22" });
  });

  it("returns null when the table or fields are missing", () => {
    expect(parseCloudTestCreds("")).toBeNull();
    expect(parseCloudTestCreds('[cloud_test_user]\nemail = "user@example.com"\n')).toBeNull();
    expect(parseCloudTestCreds('[other]\nemail = "user@example.com"\npassword = "x"\n')).toBeNull();
  });

  it("throws a clear error on invalid TOML", () => {
    expect(() => parseCloudTestCreds("not toml at all =")).toThrow("creds.toml is not valid TOML");
  });

  it("reads credentials from disk and reports malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-cloud-creds-"));
    try {
      expect(readCloudTestCredentials(join(dir, "missing.toml"))).toBeNull();

      const valid = join(dir, "creds.toml");
      writeFileSync(valid, '[cloud_test_user]\nemail = "user@example.com"\npassword = "pw"\n');
      expect(readCloudTestCredentials(valid)).toEqual({ email: "user@example.com", password: "pw" });

      const incomplete = join(dir, "incomplete.toml");
      writeFileSync(incomplete, "[cloud_test_user]\n");
      expect(() => readCloudTestCredentials(incomplete)).toThrow("has no [cloud_test_user]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fills cloud test env vars without overriding explicit values", () => {
    const applied = applyCloudTestCredentialEnv(
      { KANNA_CLOUD_TEST_EMAIL: "explicit@example.com" },
      { email: "file@example.com", password: "file-pw" },
    );
    expect(applied.KANNA_CLOUD_TEST_EMAIL).toBe("explicit@example.com");
    expect(applied.KANNA_CLOUD_TEST_PASSWORD).toBe("file-pw");

    const untouched = applyCloudTestCredentialEnv({ A: "1" }, null);
    expect(untouched).toEqual({ A: "1" });
  });

  it("fills production cloud env defaults without overriding explicit values", () => {
    const applied = applyProductionCloudEnv({ KANNA_RELAY_URL: "ws://127.0.0.1:9080" });
    expect(applied.KANNA_RELAY_URL).toBe("ws://127.0.0.1:9080");
    expect(applied.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-build");
    expect(applied.KANNA_FIREBASE_API_KEY).toMatch(/^AIza/);
    expect(applied.KANNA_FIREBASE_APP_ID).toContain(":web:");

    const defaulted = applyProductionCloudEnv({});
    expect(defaulted.KANNA_RELAY_URL).toBe("wss://relay.kanna.build");
  });
});
