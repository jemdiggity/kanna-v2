/**
 * The comp grant script itself, as a process, against the real emulators.
 *
 * `src/billing/comp.ts` is covered as a library in `comp-grant.test.ts`; this
 * suite covers the part of the operator surface that only exists in the script:
 * argument parsing, `--dry-run`, `--revoke`, and the two guards that stand
 * between a routine dev shell and a write to a real Firebase project. Those
 * guards read the process environment and decide where Firebase Auth and
 * Firestore each resolve, so nothing short of running the process proves them.
 *
 * Skipped without the emulators; run with
 * `./kd emulators exec -- pnpm --filter @kanna/firebase-functions test`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  billingSourcePath,
  entitlementPath,
  type CompSourceState,
  type EntitlementRecord,
} from "../src/billing/types.js";
import {
  clearFirestoreEmulator,
  EMULATOR_PROJECT_ID,
  hasFirestoreEmulator,
} from "./support/emulator.js";

/**
 * The script resolves email targets through Firebase Auth, so this suite needs
 * the auth emulator as well as Firestore. `./kd emulators exec` exports both.
 */
const hasEmulators = hasFirestoreEmulator && Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
const describeWithEmulator = hasEmulators ? describe : describe.skip;

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = "scripts/grant-comp-access.mjs";

const UID = "comp-script-user";
const EMAIL = "comp-script@example.com";
const REAL_PROJECT = "kanna-build";

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command in the package directory with a chosen environment.
 * `undefined` in `env` removes the variable, which is how a run reproduces an
 * operator who unset one emulator host but not the other.
 */
function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<ScriptRun> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn(command, args, { cwd: PACKAGE_DIR, env: childEnv, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function runScript(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<ScriptRun> {
  return run("node", [SCRIPT, ...args], env);
}

describeWithEmulator("comp grant script", () => {
  let app: App | null = null;
  let db: Firestore;

  beforeAll(async () => {
    // The script imports the compiled reducer, exactly as `comp:grant` does —
    // which builds first for the same reason.
    const build = await run("pnpm", ["build"]);
    if (build.code !== 0) {
      throw new Error(`building @kanna/firebase-functions failed:\n${build.stdout}${build.stderr}`);
    }

    app = initializeApp({ projectId: EMULATOR_PROJECT_ID }, `comp-script-tests-${process.pid}`);
    db = getFirestore(app);
    const auth = getAuth(app);
    await auth.deleteUser(UID).catch(() => {
      // First run, or a previous one cleaned up after itself.
    });
    await auth.createUser({ uid: UID, email: EMAIL, emailVerified: true });
  }, 120_000);

  afterEach(async () => {
    await clearFirestoreEmulator();
  });

  afterAll(async () => {
    if (!app) return;
    await getAuth(app).deleteUser(UID).catch(() => {
      // Nothing to clean up.
    });
    await deleteApp(app);
    app = null;
  });

  async function entitlement(): Promise<EntitlementRecord | undefined> {
    return (await db.doc(entitlementPath(UID)).get()).data() as EntitlementRecord | undefined;
  }

  async function comp(): Promise<CompSourceState | undefined> {
    return (await db.doc(billingSourcePath(UID, "comp")).get()).data() as CompSourceState | undefined;
  }

  it("grants by email and drives the reducer", async () => {
    const result = await runScript(["--reason", "grandfathered", EMAIL]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(UID);
    expect(await comp()).toMatchObject({ active: true, reason: "grandfathered" });
    // The derived record is the whole point: the script recomputes it itself,
    // because no Firestore trigger watches the source docs.
    expect(await entitlement()).toMatchObject({ status: "active", source: "comp" });
  });

  it("revokes the same account", async () => {
    expect((await runScript([EMAIL])).code).toBe(0);
    expect(await entitlement()).toMatchObject({ status: "active", source: "comp" });

    const revoke = await runScript(["--revoke", EMAIL]);

    expect(revoke.code, revoke.stderr).toBe(0);
    expect(await comp()).toMatchObject({ active: false });
    expect((await comp())?.revokedAt).toEqual(expect.any(String));
    // No paid source remains, so cloud access ends rather than falling back.
    expect(await entitlement()).toMatchObject({ status: "expired", capabilities: [] });
  });

  it("writes nothing under --dry-run", async () => {
    const result = await runScript(["--dry-run", EMAIL]);

    expect(result.code, result.stderr).toBe(0);
    // It still resolves the account, so a typo is caught by the rehearsal too.
    expect(result.stdout).toContain(UID);
    expect(await comp()).toBeUndefined();
    expect(await entitlement()).toBeUndefined();
  });

  it("refuses a real project that is not confirmed", async () => {
    const result = await runScript(["--project", REAL_PROJECT, EMAIL]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`--confirm ${REAL_PROJECT}`);
    expect(await comp()).toBeUndefined();
  });

  it("refuses a real project while an emulator still resolves identities", async () => {
    // The documented procedure, run from an ordinary dev shell that unset only
    // the Firestore host: without this guard the email resolves against the
    // emulator's user directory while the grant is written to the real
    // project, comping a uid nobody owns and leaving the intended account
    // untouched.
    const result = await runScript(
      ["--project", REAL_PROJECT, "--confirm", REAL_PROJECT, EMAIL],
      { FIRESTORE_EMULATOR_HOST: undefined },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FIREBASE_AUTH_EMULATOR_HOST");
    expect(result.stderr).not.toContain("FIRESTORE_EMULATOR_HOST=");
    expect(await comp()).toBeUndefined();
  });

  it("refuses a real project while Firestore still points at an emulator", async () => {
    // The mirror image, so the refusal names the variable that is actually set
    // rather than whichever one the guard happens to check first.
    const result = await runScript(
      ["--project", REAL_PROJECT, "--confirm", REAL_PROJECT, EMAIL],
      { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FIRESTORE_EMULATOR_HOST");
    expect(result.stderr).not.toContain("FIREBASE_AUTH_EMULATOR_HOST");
    expect(await comp()).toBeUndefined();
  });

  it("refuses to run with no emulator and no named project", async () => {
    const result = await runScript([EMAIL], {
      FIRESTORE_EMULATOR_HOST: undefined,
      FIREBASE_AUTH_EMULATOR_HOST: undefined,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("FIRESTORE_EMULATOR_HOST is not set");
  });
});
