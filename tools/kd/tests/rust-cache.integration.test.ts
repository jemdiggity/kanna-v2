import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  warmRustCache,
  withRustCacheBuild
} from "../src/runtime/rust-cache";
import type { RustCacheRuntimeInput } from "../src/runtime/rust-cache";
import { resolveKanachePaths } from "../src/runtime/rust-cache-policy";
import { nodeCommandRunner } from "../src/runtime/process";

interface IntegrationFixture {
  root: string;
  repo: string;
  home: string;
  log: string;
  head: string;
  hostTarget: string;
  env: NodeJS.ProcessEnv;
  cache: RustCacheRuntimeInput;
}

const roots: string[] = [];
const describeMac = process.platform === "darwin" ? describe : describe.skip;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const result = await nodeCommandRunner.run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function fakeKanacheSource(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = process.env.FAKE_KANACHE_LOG;
fs.appendFileSync(log, JSON.stringify({ command: "kanache", args }) + "\\n");

if (args[0] === "warm") {
  const donor = args[1];
  const destination = args[2];
  const refused = new Set((process.env.FAKE_KANACHE_REFUSE || "").split(path.delimiter));
  if (refused.has(donor)) {
    process.stderr.write("configured donor refusal\\n");
    process.exit(23);
  }
  const buildRoot = path.join(destination, ".build", "cargo-build");
  if (fs.existsSync(buildRoot)) {
    process.stderr.write("destination already exists\\n");
    process.exit(24);
  }
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.copyFileSync(
    path.join(donor, ".build", "cargo-build", ".kanache-manifest.json"),
    path.join(buildRoot, ".kanache-manifest.json")
  );
  fs.writeFileSync(path.join(buildRoot, "published-from"), donor + "\\n");
  process.stdout.write("warmed files=1 elapsed_ms=1\\n");
  process.exit(0);
}

if (args[0] === "manifest" && args[1] === "begin") {
  const marker = path.join(args[2], ".build", "cargo-build", ".kanache-success");
  if (fs.existsSync(marker)) {
    process.stderr.write("begin observed stale success marker\\n");
    process.exit(25);
  }
  process.exit(0);
}

if (args[0] === "manifest" && args[1] === "record") {
  const repo = args[2];
  const targets = [];
  for (let index = 3; index < args.length; index += 1) {
    if (args[index] === "--target") targets.push(args[index + 1]);
  }
  const buildRoot = path.join(repo, ".build", "cargo-build");
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.writeFileSync(
    path.join(buildRoot, ".kanache-manifest.json"),
    JSON.stringify({
      profiles: ["dev"],
      targets,
      extra_inputs: [],
      created_unix_nanos: Date.now() * 1000000
    })
  );
  fs.writeFileSync(path.join(buildRoot, ".kanache-success"), "recorded\\n");
  process.exit(0);
}

process.stderr.write("unsupported fake Kanache invocation: " + args.join(" ") + "\\n");
process.exit(26);
`;
}

async function createFixture(): Promise<IntegrationFixture> {
  const root = mkdtempSync(join(tmpdir(), "kd-kanache-integration-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  const log = join(root, "processes.jsonl");
  mkdirSync(repo, { recursive: true });

  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.email", "kd-tests@kanna.build"], { cwd: repo });
  await run("git", ["config", "user.name", "Kanna kd tests"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".build/\n");
  writeFileSync(join(repo, "fixture.txt"), "first\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "fixture base"], { cwd: repo });
  writeFileSync(join(repo, "fixture.txt"), "second\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "fixture head"], { cwd: repo });

  const head = await run("git", ["rev-parse", "HEAD"], { cwd: repo });
  const rustc = await run("rustc", ["-vV"], { cwd: repo });
  const hostTarget = rustc
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length);
  if (!hostTarget) throw new Error("rustc -vV did not report a host target");

  const binary = resolveKanachePaths(home).binary;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, fakeKanacheSource());
  chmodSync(binary, 0o755);
  const env = {
    ...process.env,
    CI: "",
    KANNA_RUST_CACHE: "on",
    FAKE_KANACHE_LOG: log
  };

  return {
    root,
    repo,
    home,
    log,
    head,
    hostTarget,
    env,
    cache: {
      repoRoot: repo,
      homeDir: home,
      env,
      runner: nodeCommandRunner,
      commit: head,
      platform: "darwin"
    }
  };
}

async function addWorktree(
  fixture: IntegrationFixture,
  name: string,
  revision = fixture.head
): Promise<string> {
  const path = join(fixture.root, name);
  await run("git", ["worktree", "add", "--detach", path, revision], {
    cwd: fixture.repo
  });
  return path;
}

function writeDonor(
  fixture: IntegrationFixture,
  path: string,
  createdUnixNanos: number
): void {
  const buildRoot = join(path, ".build", "cargo-build");
  mkdirSync(buildRoot, { recursive: true });
  writeFileSync(
    join(buildRoot, ".kanache-manifest.json"),
    JSON.stringify({
      profiles: ["dev"],
      targets: ["host", fixture.hostTarget],
      extra_inputs: [],
      created_unix_nanos: createdUnixNanos
    })
  );
  writeFileSync(join(buildRoot, ".kanache-success"), "eligible\n");
}

function readProcessLog(fixture: IntegrationFixture): Array<{
  command: string;
  args: string[];
}> {
  if (!existsSync(fixture.log)) return [];
  return readFileSync(fixture.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string; args: string[] });
}

describeMac("Kanache Git worktree integration", () => {
  it("uses exact-HEAD donors from the same repository and falls back after refusal", async () => {
    const fixture = await createFixture();
    const refused = await addWorktree(fixture, "refused");
    const accepted = await addWorktree(fixture, "accepted");
    const wrongHead = await addWorktree(fixture, "wrong-head", "HEAD^");
    const foreignCandidate = await addWorktree(fixture, "foreign-candidate");
    for (const [path, created] of [
      [foreignCandidate, 40],
      [wrongHead, 35],
      [refused, 30],
      [accepted, 20]
    ] as const) {
      writeDonor(fixture, path, created);
    }

    const foreignRepo = join(fixture.root, "foreign-repo");
    await run("git", ["clone", "--no-local", fixture.repo, foreignRepo], {
      cwd: fixture.root
    });
    writeFileSync(join(foreignCandidate, ".git"), `gitdir: ${join(foreignRepo, ".git")}\n`);

    const canonicalRefused = realpathSync(refused);
    const canonicalAccepted = realpathSync(accepted);
    const canonicalWrongHead = realpathSync(wrongHead);
    const canonicalForeignCandidate = realpathSync(foreignCandidate);

    const result = await warmRustCache({
      ...fixture.cache,
      env: {
        ...fixture.env,
        FAKE_KANACHE_REFUSE: canonicalRefused
      }
    });

    expect(result.category).toBe("warmed");
    expect(result).toMatchObject({
      ok: true,
      outcome: "hit",
      donor: canonicalAccepted
    });
    expect(readFileSync(join(fixture.repo, ".build/cargo-build/published-from"), "utf8").trim())
      .toBe(canonicalAccepted);
    const warmDonors = readProcessLog(fixture)
      .filter((entry) => entry.args[0] === "warm")
      .map((entry) => entry.args[1]);
    expect(warmDonors).toEqual([canonicalRefused, canonicalAccepted]);
    expect(warmDonors).not.toContain(canonicalWrongHead);
    expect(warmDonors).not.toContain(canonicalForeignCandidate);
  });

  it("does not invoke Kanache or delete an existing destination", async () => {
    const fixture = await createFixture();
    const donor = await addWorktree(fixture, "donor");
    writeDonor(fixture, donor, 10);
    const keep = join(fixture.repo, ".build", "cargo-build", "keep");
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(keep, "private destination\n");

    const result = await warmRustCache(fixture.cache);

    expect(result).toMatchObject({ outcome: "miss", category: "destination-exists" });
    expect(readFileSync(keep, "utf8")).toBe("private destination\n");
    expect(readProcessLog(fixture)).toEqual([]);
  });

  it("wires begin, a real build process, and record around donor publication", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.repo, ".build", "cargo-build", ".kanache-success");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "stale\n");

    const result = await withRustCacheBuild(
      fixture.cache,
      "all",
      async () => {
        const build = await nodeCommandRunner.run(
          process.execPath,
          [
            "-e",
            `const fs=require("node:fs");fs.appendFileSync(process.env.FAKE_KANACHE_LOG, JSON.stringify({command:"build",args:[]})+"\\n");fs.mkdirSync(".build/cargo-build",{recursive:true});fs.writeFileSync(".build/cargo-build/build-output","built\\n");`
          ],
          { cwd: fixture.repo, env: fixture.env }
        );
        return build;
      },
      (build) => build.exitCode === 0
    );

    expect(result.exitCode).toBe(0);
    expect(readProcessLog(fixture).map((entry) => entry.command + " " + entry.args.slice(0, 2).join(" ")))
      .toEqual([
        `kanache manifest begin`,
        "build ",
        `kanache manifest record`
      ]);
    expect(existsSync(marker)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(fixture.repo, ".build/cargo-build/.kanache-manifest.json"), "utf8")
      )
    ).toMatchObject({
      profiles: ["dev"],
      targets: expect.arrayContaining(["host", fixture.hostTarget])
    });
    expect(readFileSync(join(fixture.repo, ".build/cargo-build/build-output"), "utf8"))
      .toBe("built\n");
  });
});

it.skipIf(
  process.platform !== "darwin" || process.env.KANNA_REAL_KANACHE_ACCEPTANCE !== "1"
)("warms a real Cargo sibling with the pinned Kanache revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "kd-kanache-acceptance-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".cargo"), { recursive: true });
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.email", "kd-tests@kanna.build"], { cwd: repo });
  await run("git", ["config", "user.name", "Kanna kd tests"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".build/\n");
  writeFileSync(
    join(repo, ".cargo", "config.toml"),
    '[build]\ntarget-dir = ".build"\nbuild-dir = ".build/cargo-build"\n'
  );
  writeFileSync(
    join(repo, "Cargo.toml"),
    '[package]\nname = "kanache-acceptance"\nversion = "0.1.0"\nedition = "2024"\n'
  );
  writeFileSync(
    join(repo, "src", "main.rs"),
    'fn main() { println!("real pinned Kanache acceptance"); }\n'
  );
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "acceptance fixture"], { cwd: repo });
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: repo });
  const rustc = await run("rustc", ["-vV"], { cwd: repo });
  const hostTarget = rustc
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length);
  if (!hostTarget) throw new Error("rustc -vV did not report a host target");
  const env = { ...process.env, KANNA_RUST_CACHE: "on" };
  const donorCache: RustCacheRuntimeInput = {
    repoRoot: repo,
    homeDir: home,
    env,
    runner: nodeCommandRunner,
    commit: head
  };

  const donorBuild = await withRustCacheBuild(
    donorCache,
    "all",
    async () => {
      const implicit = await nodeCommandRunner.run("cargo", ["build"], { cwd: repo, env });
      if (implicit.exitCode !== 0) return implicit;
      return nodeCommandRunner.run("cargo", ["build", "--target", hostTarget], {
        cwd: repo,
        env
      });
    },
    (result) => result.exitCode === 0
  );
  expect(donorBuild.exitCode, donorBuild.stderr).toBe(0);
  expect(existsSync(join(repo, ".build/cargo-build/.kanache-success"))).toBe(true);

  const sibling = join(root, "sibling");
  await run("git", ["worktree", "add", "--detach", sibling, head], { cwd: repo });
  const warm = await warmRustCache({ ...donorCache, repoRoot: sibling });
  expect(warm).toMatchObject({ outcome: "hit", category: "warmed" });
  const siblingImplicitBuild = await nodeCommandRunner.run("cargo", ["build"], {
    cwd: sibling,
    env
  });
  expect(siblingImplicitBuild.exitCode, siblingImplicitBuild.stderr).toBe(0);
  const siblingExplicitBuild = await nodeCommandRunner.run(
    "cargo",
    ["build", "--target", hostTarget],
    { cwd: sibling, env }
  );
  expect(siblingExplicitBuild.exitCode, siblingExplicitBuild.stderr).toBe(0);

  const donorBinary = join(repo, ".build", "debug", "kanache-acceptance");
  const siblingBinary = join(sibling, ".build", "debug", "kanache-acceptance");
  expect(existsSync(donorBinary)).toBe(true);
  expect(existsSync(siblingBinary)).toBe(true);
  expect(statSync(donorBinary).ino).not.toBe(statSync(siblingBinary).ino);
}, 600_000);
