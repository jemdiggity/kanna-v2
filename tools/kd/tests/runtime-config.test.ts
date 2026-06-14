import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFirebaseCommandEnv,
  buildFirebaseEmulatorArgs,
  formatMissingFirebaseEmulators,
  resolveFirebaseEnvFromReference,
  writeFirebaseEmulatorConfig,
} from "../src/runtime/firebase";
import { readDesktopBundleIdentifier, writeTauriLocalConfig } from "../src/runtime/tauri";

describe("runtime config generation", () => {
  it("writes a local Firebase emulator config without mutating firebase.json", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-firebase-"));
    const firebaseJson = {
      functions: { source: "services/firebase-functions" },
      emulators: {
        auth: { port: 9099 },
        firestore: { port: 8080 },
        functions: { port: 5001 },
        ui: { enabled: true, port: 4000 }
      }
    };
    writeFileSync(join(root, "firebase.json"), JSON.stringify(firebaseJson, null, 2));

    const generatedPath = writeFirebaseEmulatorConfig(root, {
      KANNA_FIREBASE_AUTH_PORT: 19099,
      KANNA_FIREBASE_FIRESTORE_PORT: 18080,
      KANNA_FIREBASE_FUNCTIONS_PORT: 15001,
      KANNA_FIREBASE_UI_PORT: 14000
    });

    expect(generatedPath).toBe(join(root, ".firebase-18080.kanna.json"));
    expect(JSON.parse(readFileSync(generatedPath, "utf8"))).toMatchObject({
      functions: {
        source: "services/firebase-functions",
        runtime: "nodejs24"
      },
      emulators: {
        auth: { host: "0.0.0.0", port: 19099 },
        firestore: { host: "0.0.0.0", port: 18080 },
        functions: { host: "0.0.0.0", port: 15001 },
        ui: { enabled: true, host: "0.0.0.0", port: 14000 }
      }
    });
    expect(JSON.parse(readFileSync(join(root, "firebase.json"), "utf8"))).toEqual(firebaseJson);
  });

  it("writes Tauri local dev URL config", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-tauri-"));
    const path = writeTauriLocalConfig(root, 1555);
    expect(path).toBe(join(root, "apps/desktop/src-tauri/tauri.conf.local.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      build: { devUrl: "http://localhost:1555" }
    });
  });

  it("reads the desktop bundle identifier from Tauri config", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-tauri-id-"));
    const configDir = join(root, "apps/desktop/src-tauri");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "tauri.conf.json"), JSON.stringify({ identifier: "dev.kanna" }));

    expect(readDesktopBundleIdentifier(root)).toBe("dev.kanna");
  });

  it("builds Firebase emulator command args from generated config", () => {
    expect(buildFirebaseEmulatorArgs("/repo/.firebase-8080.kanna.json", [])).toEqual([
      "exec",
      "firebase",
      "emulators:start",
      "--project",
      "kanna-local",
      "--config",
      "/repo/.firebase-8080.kanna.json",
      "--import",
      "/repo/services/firebase/emulator-seed"
    ]);
    expect(buildFirebaseEmulatorArgs("/repo/.firebase-8080.kanna.json", ["--only", "auth"])).toContain("--only");
  });

  it("adds repo node_modules to Firebase command NODE_PATH", () => {
    expect(buildFirebaseCommandEnv("/repo", { FOO: "bar" })).toMatchObject({
      FOO: "bar",
      NODE_PATH: "/repo/node_modules"
    });
    expect(buildFirebaseCommandEnv("/repo", { NODE_PATH: "/existing" }).NODE_PATH).toBe("/repo/node_modules:/existing");
  });

  it("resolves Firebase emulator ports from a sibling worktree config", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-firebase-from-"));
    const worktreesRoot = join(root, ".kanna-worktrees");
    const current = join(worktreesRoot, "task-current");
    const source = join(worktreesRoot, "task-source");
    mkdirSync(current, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, ".firebase-18081.kanna.json"), JSON.stringify({
      emulators: {
        auth: { port: 19100 },
        firestore: { port: 18081 },
        functions: { port: 15002 },
        ui: { port: 14001 }
      }
    }));

    expect(resolveFirebaseEnvFromReference(current, "task-source")).toEqual({
      KANNA_FIREBASE_AUTH_PORT: "19100",
      KANNA_FIREBASE_FIRESTORE_PORT: "18081",
      KANNA_FIREBASE_FUNCTIONS_PORT: "15002",
      KANNA_FIREBASE_UI_PORT: "14001"
    });
  });

  it("reports a clear error when the borrowed Firebase config is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kd-firebase-from-missing-"));
    const current = join(root, ".kanna-worktrees", "task-current");
    mkdirSync(current, { recursive: true });

    expect(() => resolveFirebaseEnvFromReference(current, "task-missing")).toThrow(
      "No Firebase emulator config found for task-missing"
    );
  });

  it("formats missing borrowed Firebase emulator listeners", () => {
    expect(formatMissingFirebaseEmulators("task-source", [
      { name: "auth", port: 19100, listening: true, pids: ["123"] },
      { name: "firestore", port: 18081, listening: false, pids: [] },
      { name: "functions", port: 15002, listening: false, pids: [] }
    ])).toBe("Firebase emulator ports from task-source are not listening: firestore:18081, functions:15002");
  });
});
