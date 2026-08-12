import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseMocks = vi.hoisted(() => ({
  cutReleaseBranch: vi.fn(),
  releaseStatus: vi.fn(),
  shipRelease: vi.fn()
}));

vi.mock("../src/runtime/release", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/release")>();
  return {
    ...actual,
    cutReleaseBranch: releaseMocks.cutReleaseBranch,
    releaseStatus: releaseMocks.releaseStatus,
    shipRelease: releaseMocks.shipRelease
  };
});

import { nodeCommandRunner } from "../src/runtime/process";
import { loadReleaseEnvironment } from "../src/runtime/release-env";
import { getTaskDefinition } from "../src/tasks/registry";

const updaterTestKeyPair = generateKeyPairSync("ed25519");
const updaterTestKeyId = Buffer.from("0102030405060708", "hex");
const updaterPublicDer = updaterTestKeyPair.publicKey.export({ format: "der", type: "spki" });
const updaterPublicPayload = Buffer.concat([
  Buffer.from("Ed"),
  updaterTestKeyId,
  updaterPublicDer.subarray(-32)
]);
const updaterTestPublicKey = Buffer.from(
  `untrusted comment: minisign public key\n${updaterPublicPayload.toString("base64")}\n`
).toString("base64");

interface Fixture {
  primary: string;
  worktree: string;
  keychain: string;
  home: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "kanna-release-tasks-"));
  const primary = join(root, "repo");
  const worktree = join(primary, ".kanna-worktrees", "task-123");
  const home = join(root, "home");
  await mkdir(join(home, ".kanna"), { recursive: true });
  await mkdir(join(worktree, ".kanna"), { recursive: true });
  await mkdir(join(worktree, "apps", "desktop", "src-tauri"), { recursive: true });
  await writeFile(join(worktree, ".kanna", "config.json"), "{}\n");
  await writeFile(
    join(worktree, "apps", "desktop", "src-tauri", "tauri.conf.json"),
    '{"identifier":"build.kanna.test"}\n'
  );
  await mkdir(primary, { recursive: true });
  const keychain = join(root, "login.keychain-db");
  await writeFile(keychain, "keychain fixture\n");
  const releaseEnvPath = join(home, ".kanna", ".env.release.local");
  await writeFile(releaseEnvPath, "RELEASE_DEFAULT=file\n", { mode: 0o600 });
  await chmod(releaseEnvPath, 0o600);
  return { primary, worktree, keychain, home };
}

function mockGitContext(
  fixture: Fixture,
  notaryResult?: { exitCode: number; stdout: string; stderr: string },
  updaterKeyMaterial?: string
): void {
  let updaterLookupCount = 0;
  vi.stubEnv("HOME", fixture.home);
  vi.spyOn(nodeCommandRunner, "run").mockImplementation(async (command, args) => {
    if (command === "xcrun" && args[0] === "notarytool") {
      if (!notaryResult) throw new Error("unexpected notarytool preflight");
      return notaryResult;
    }
    if (command === "security" && args[0] === "default-keychain") {
      if (!updaterKeyMaterial) throw new Error("unexpected updater key setup");
      return { exitCode: 0, stdout: `"${fixture.keychain}"\n`, stderr: "" };
    }
    if (command === "security" && args[0] === "add-generic-password") {
      if (!updaterKeyMaterial) throw new Error("unexpected updater key prompt");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "security" && args[0] === "find-generic-password") {
      if (!updaterKeyMaterial) throw new Error("unexpected updater key lookup");
      updaterLookupCount += 1;
      if (updaterLookupCount === 1) {
        return {
          exitCode: 44,
          stdout: "",
          stderr: "SecKeychainSearchCopyNext: The specified item could not be found."
        };
      }
      return { exitCode: 0, stdout: `${updaterKeyMaterial}\n`, stderr: "" };
    }
    if (command === "pnpm" && args.includes("signer")) {
      const challengePath = args.at(-1);
      if (!challengePath) throw new Error("missing updater verification challenge");
      const challenge = await readFile(challengePath);
      const signature = signDigest(
        null,
        createHash("blake2b512").update(challenge).digest(),
        updaterTestKeyPair.privateKey
      );
      const signaturePayload = Buffer.concat([
        Buffer.from("ED"),
        updaterTestKeyId,
        signature
      ]);
      const envelope = `untrusted comment: test signature\n${signaturePayload.toString("base64")}\n`;
      await writeFile(`${challengePath}.sig`, Buffer.from(envelope).toString("base64"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command !== "git") throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: `${fixture.worktree}\n`, stderr: "" };
    }
    if (key === "rev-parse --abbrev-ref HEAD") {
      return { exitCode: 0, stdout: "task-123\n", stderr: "" };
    }
    if (key === "rev-parse --short HEAD") {
      return { exitCode: 0, stdout: "abc123\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${key}`);
  });
}

describe("release task environment integration", () => {
  beforeEach(() => {
    releaseMocks.shipRelease.mockResolvedValue({
      version: "1.2.3",
      dmgPaths: [],
      updaterPaths: [],
      latestJson: "/tmp/latest.json"
    });
    releaseMocks.cutReleaseBranch.mockResolvedValue({
      branch: "release/1.3",
      version: "1.3.0",
      commit: "abc123"
    });
    vi.stubEnv("APPLE_KEYCHAIN_PROFILE", "shell-profile");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    releaseMocks.cutReleaseBranch.mockReset();
    releaseMocks.releaseStatus.mockReset();
    releaseMocks.shipRelease.mockReset();
  });

  it("passes merged release defaults to the ship task", async () => {
    const fixture = await createFixture();
    const releaseEnvPath = join(fixture.home, ".kanna", ".env.release.local");
    await writeFile(
      releaseEnvPath,
      [
        "RELEASE_DEFAULT=file",
        "KANNA_UPDATER_PUBKEY=file-pubkey",
        "KANNA_UPDATER_KEYCHAIN_SERVICE=file-service",
        "KANNA_UPDATER_KEYCHAIN_ACCOUNT=file-account",
        `KANNA_UPDATER_KEYCHAIN_PATH=${JSON.stringify(fixture.keychain)}`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await chmod(releaseEnvPath, 0o600);
    mockGitContext(fixture);

    await getTaskDefinition("release.ship").execute(
      { cwd: fixture.worktree, env: {} },
      { dryRun: true, arm64: true }
    );

    expect(releaseMocks.shipRelease).toHaveBeenCalledOnce();
    expect(releaseMocks.shipRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          APPLE_KEYCHAIN_PROFILE: "shell-profile",
          RELEASE_DEFAULT: "file",
          KANNA_UPDATER_PUBKEY: "file-pubkey",
          KANNA_UPDATER_KEYCHAIN_SERVICE: "file-service",
          KANNA_UPDATER_KEYCHAIN_ACCOUNT: "file-account",
          KANNA_UPDATER_KEYCHAIN_PATH: fixture.keychain
        })
      })
    );
  });

  it("passes merged release defaults to the promote task", async () => {
    const fixture = await createFixture();
    mockGitContext(fixture);

    await getTaskDefinition("release.promote").execute(
      { cwd: fixture.worktree, env: {} },
      { version: "1.2.3-staging.1", dryRun: true }
    );

    expect(releaseMocks.shipRelease).toHaveBeenCalledOnce();
    expect(releaseMocks.shipRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        promoteFrom: "1.2.3-staging.1",
        env: expect.objectContaining({
          APPLE_KEYCHAIN_PROFILE: "shell-profile",
          RELEASE_DEFAULT: "file"
        })
      })
    );
  });

  it("does not load the release dotenv file for the cut task", async () => {
    const fixture = await createFixture();
    mockGitContext(fixture);

    await getTaskDefinition("release.cut").execute(
      { cwd: fixture.worktree, env: {} },
      { minor: true }
    );

    expect(releaseMocks.cutReleaseBranch).toHaveBeenCalledOnce();
    const input = releaseMocks.cutReleaseBranch.mock.calls[0]?.[0] as {
      env: NodeJS.ProcessEnv;
    };
    expect(input.env.RELEASE_DEFAULT).toBeUndefined();
    expect(nodeCommandRunner.run).not.toHaveBeenCalledWith(
      "git",
      ["worktree", "list", "--porcelain"],
      expect.anything()
    );
  });

  it("stops before the ship/build/publish boundary when the selected profile is missing", async () => {
    const fixture = await createFixture();
    vi.stubEnv("APPLE_KEYCHAIN_PATH", fixture.keychain);
    mockGitContext(fixture, {
      exitCode: 69,
      stdout: "",
      stderr: "No Keychain password item found for profile: shell-profile"
    });

    await expect(getTaskDefinition("release.ship").execute(
      { cwd: fixture.worktree, env: {} },
      { staging: true, release: true, patch: true }
    )).rejects.toThrow(/profile is missing from the selected Keychain/);

    expect(releaseMocks.shipRelease).not.toHaveBeenCalled();
    expect(nodeCommandRunner.run).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(?:bazel|gh)$/),
      expect.anything(),
      expect.anything()
    );
    expect(nodeCommandRunner.run).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["tag"]),
      expect.anything()
    );
  });

  it("uses setup selectors from the global file without reading or changing repository files", async () => {
    const fixture = await createFixture();
    vi.stubEnv("APPLE_KEYCHAIN_PROFILE", undefined);
    const repositoryEnvPath = join(fixture.primary, ".env.release.local");
    const repositoryEnv = [
      "# This legacy file is deliberately ignored.",
      "RELEASE_DEFAULT=repository-must-not-load",
      "APPLE_KEYCHAIN_PROFILE=legacy-profile",
      `export APPLE_KEYCHAIN_PATH=${fixture.keychain}`,
      "LOCAL_ONLY=must-not-load",
      ""
    ].join("\n");
    await writeFile(repositoryEnvPath, repositoryEnv);
    mockGitContext(fixture, { exitCode: 0, stdout: '{"history":[]}', stderr: "" });

    await getTaskDefinition("release.setup-notarization").execute(
      { cwd: fixture.worktree, env: {} },
      { profile: "machine-profile", keychain: fixture.keychain }
    );

    expect(await readFile(repositoryEnvPath, "utf8")).toBe(repositoryEnv);
    const loaded = loadReleaseEnvironment({ homeDir: fixture.home, env: {} });
    expect(loaded).toEqual(expect.objectContaining({
      APPLE_KEYCHAIN_PROFILE: "machine-profile",
      APPLE_KEYCHAIN_PATH: fixture.keychain,
      RELEASE_DEFAULT: "file"
    }));
    expect(loaded.LOCAL_ONLY).toBeUndefined();

    await getTaskDefinition("release.ship").execute(
      { cwd: fixture.worktree, env: {} },
      { staging: true, release: true, patch: true, arm64: true }
    );
    await getTaskDefinition("release.promote").execute(
      { cwd: fixture.worktree, env: {} },
      { version: "1.2.3-staging.1", arm64: true }
    );

    expect(releaseMocks.shipRelease).toHaveBeenCalledTimes(2);
    for (const call of releaseMocks.shipRelease.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        env: expect.objectContaining({
          APPLE_KEYCHAIN_PROFILE: "machine-profile",
          APPLE_KEYCHAIN_PATH: fixture.keychain,
          RELEASE_DEFAULT: "file"
        })
      }));
    }
    expect(nodeCommandRunner.run).toHaveBeenCalledWith(
      "xcrun",
      [
        "notarytool",
        "history",
        "--keychain-profile",
        "machine-profile",
        "--keychain",
        fixture.keychain,
        "--output-format",
        "json",
        "--no-progress"
      ],
      expect.objectContaining({ cwd: fixture.worktree })
    );
  });

  it("loads machine-global updater config but leaves secret entry to the native prompt", async () => {
    const fixture = await createFixture();
    const privateKeyPath = join(fixture.home, "updater-private.key");
    const releaseEnvPath = join(fixture.home, ".kanna", ".env.release.local");
    await writeFile(
      releaseEnvPath,
      `RELEASE_DEFAULT=file\nKANNA_UPDATER_PUBKEY=${updaterTestPublicKey}\nTAURI_PRIVATE_KEY_PATH=${JSON.stringify(privateKeyPath)}\n`,
      { mode: 0o600 }
    );
    await chmod(releaseEnvPath, 0o600);
    mockGitContext(fixture, undefined, "secret updater key");

    await getTaskDefinition("release.setup-updater-key").execute(
      { cwd: fixture.worktree, env: {} },
      { keychain: fixture.keychain }
    );

    expect(nodeCommandRunner.run).toHaveBeenCalledWith(
      "security",
      [
        "add-generic-password",
        "-s",
        "build.kanna.updater-key",
        "-a",
        "tauri-updater-signing-key",
        "-w"
      ],
      expect.objectContaining({
        cwd: fixture.worktree,
        interactive: true,
        env: expect.objectContaining({
          TAURI_PRIVATE_KEY_PATH: privateKeyPath,
          KANNA_UPDATER_PUBKEY: updaterTestPublicKey,
          RELEASE_DEFAULT: "file"
        })
      })
    );
    const loaded = loadReleaseEnvironment({ homeDir: fixture.home, env: {} });
    expect(loaded).toEqual(expect.objectContaining({
      KANNA_UPDATER_KEYCHAIN_SERVICE: "build.kanna.updater-key",
      KANNA_UPDATER_KEYCHAIN_ACCOUNT: "tauri-updater-signing-key",
      KANNA_UPDATER_KEYCHAIN_PATH: fixture.keychain,
      TAURI_PRIVATE_KEY_PATH: privateKeyPath
    }));
    expect(await readFile(releaseEnvPath, "utf8")).not.toContain("secret updater key");
  });
});
import { createHash, generateKeyPairSync, sign as signDigest } from "node:crypto";
