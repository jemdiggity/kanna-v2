import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  devDesktopAuth,
  devDesktopAuthPath,
  parseStagingDesktopAuth,
  readDevDesktopAuth,
  readStagingDesktopAuth,
  resolveDeveloperConfigRoot,
  stagingDesktopAuthPath,
} from "../src/runtime/developer-config";

describe("developer config", () => {
  it("resolves the canonical developer config root", () => {
    expect(resolveDeveloperConfigRoot("/Users/example")).toBe("/Users/example/.kanna/developer");
  });

  it("does not migrate the legacy dev directory", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-developer-config-"));
    const legacyRoot = join(home, ".kanna", "dev");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, "creds.toml"), "[cloud_test_user]\n");

    try {
      const resolved = resolveDeveloperConfigRoot(home);

      expect(resolved).toBe(join(home, ".kanna", "developer"));
      expect(existsSync(join(home, ".kanna", "developer", "creds.toml"))).toBe(false);
      expect(existsSync(legacyRoot)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps both roots when the canonical root already exists", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-developer-config-"));
    const canonicalRoot = join(home, ".kanna", "developer");
    const legacyRoot = join(home, ".kanna", "dev");
    mkdirSync(canonicalRoot, { recursive: true });
    mkdirSync(legacyRoot, { recursive: true });

    try {
      expect(resolveDeveloperConfigRoot(home)).toBe(canonicalRoot);
      expect(existsSync(canonicalRoot)).toBe(true);
      expect(existsSync(legacyRoot)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves the staging desktop auth path under the developer root", () => {
    expect(stagingDesktopAuthPath("/Users/example")).toBe(
      "/Users/example/.kanna/developer/staging/desktop-auth.toml",
    );
  });

  it("uses the committed emulator seed account for dev desktop auth by default", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-developer-config-"));

    try {
      expect(devDesktopAuthPath(home)).toBe(
        join(home, ".kanna", "developer", "dev", "desktop-auth.toml"),
      );
      expect(readDevDesktopAuth(home)).toEqual(devDesktopAuth);
      expect(readDevDesktopAuth(home)).toEqual({
        email: "upvote.sieve.7t@icloud.com",
        password: "password123",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows dev desktop auth to be overridden by local developer config", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-developer-config-"));
    const authPath = devDesktopAuthPath(home);

    try {
      mkdirSync(join(home, ".kanna", "developer", "dev"), { recursive: true });
      writeFileSync(authPath, '[desktop_auth]\nemail = "local@example.com"\npassword = "local-secret"\n');

      expect(readDevDesktopAuth(home)).toEqual({
        email: "local@example.com",
        password: "local-secret",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("parses staging desktop auth credentials", () => {
    expect(parseStagingDesktopAuth(
      '[desktop_auth]\nemail = "dev@example.com"\npassword = "secret"\n',
    )).toEqual({ email: "dev@example.com", password: "secret" });
  });

  it("returns null when staging desktop auth fields are missing", () => {
    expect(parseStagingDesktopAuth("")).toBeNull();
    expect(parseStagingDesktopAuth('[desktop_auth]\nemail = "dev@example.com"\n')).toBeNull();
    expect(parseStagingDesktopAuth('[other]\nemail = "dev@example.com"\npassword = "secret"\n')).toBeNull();
  });

  it("throws redacted errors for missing and malformed staging desktop auth files", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-developer-config-"));
    const authPath = stagingDesktopAuthPath(home);

    try {
      expect(() => readStagingDesktopAuth(home)).toThrow(authPath);
      expect(() => readStagingDesktopAuth(home)).toThrow("[desktop_auth]");

      mkdirSync(join(home, ".kanna", "developer", "staging"), { recursive: true });
      writeFileSync(authPath, '[desktop_auth]\nemail = "dev@example.com"\npassword = "do-not-print"\n');
      expect(readStagingDesktopAuth(home)).toEqual({
        email: "dev@example.com",
        password: "do-not-print",
      });

      writeFileSync(authPath, "[desktop_auth]\npassword = \"do-not-print\"\n");
      expect(() => readStagingDesktopAuth(home)).toThrow("[desktop_auth]");
      expect(() => readStagingDesktopAuth(home)).not.toThrow("do-not-print");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
