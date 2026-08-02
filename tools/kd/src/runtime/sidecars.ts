import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandRunner } from "./process";

const cargoManifests = [
  "crates/daemon/Cargo.toml",
  "crates/kanna-cli/Cargo.toml",
  "crates/kanna-mcp/Cargo.toml",
  "crates/kanna-server/Cargo.toml",
  "crates/task-transfer/Cargo.toml",
  "packages/terminal-recovery/Cargo.toml"
];

const sidecarBinaries = [
  "kanna-daemon",
  "kanna-cli",
  "kanna-mcp",
  "kanna-terminal-recovery",
  "kanna-server",
  "kanna-task-transfer"
];

export type SidecarProfile = "debug" | "release";

export interface StageSidecarsInput {
  repoRoot: string;
  target: string;
  profile: SidecarProfile;
  buildDir: string;
}

export function buildSidecarCargoCommands(target: string): Array<[string, string[]]> {
  return cargoManifests.map((manifest) => ["cargo", ["build", "--target", target, "--manifest-path", manifest]]);
}

export function parseRustHostTarget(output: string): string {
  const hostLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("host:"));
  const target = hostLine?.replace("host:", "").trim();
  if (!target) {
    throw new Error("Could not determine Rust host target from rustc -vV output");
  }
  return target;
}

function filesEqual(left: string, right: string): boolean {
  if (!existsSync(right)) {
    return false;
  }
  return readFileSync(left).equals(readFileSync(right));
}

export function stageSidecars(input: StageSidecarsInput): string[] {
  const buildDir = resolve(input.repoRoot, input.buildDir);
  const primarySourceDir = join(buildDir, input.target, input.profile);
  const legacySourceDir = join(buildDir, input.profile);
  const sourceDir = existsSync(primarySourceDir) || !existsSync(legacySourceDir) ? primarySourceDir : legacySourceDir;
  const binariesDir = join(input.repoRoot, "apps", "desktop", "src-tauri", "binaries");
  mkdirSync(binariesDir, { recursive: true });

  return sidecarBinaries.map((binary) => {
    const source = join(sourceDir, binary);
    if (!existsSync(source)) {
      throw new Error(`Error: ${source} not found. Build it first.`);
    }
    const destination = join(binariesDir, `${binary}-${input.target}`);
    if (!filesEqual(source, destination)) {
      copyFileSync(source, destination);
    }
    chmodSync(destination, 0o755);
    return destination;
  });
}

export async function buildDesktopSidecars(
  runner: CommandRunner,
  repoRoot: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const rustc = await runner.run("rustc", ["-vV"], { cwd: repoRoot });
  if (rustc.exitCode !== 0) {
    throw new Error(`rustc -vV failed: ${rustc.stderr}`);
  }
  const target = parseRustHostTarget(rustc.stdout);
  const env = { ...baseEnv };
  delete env.CARGO_TARGET_DIR;

  for (const [command, args] of buildSidecarCargoCommands(target)) {
    const result = await runner.run(command, args, { cwd: repoRoot, env });
    if (result.exitCode !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  return stageSidecars({ repoRoot, target, profile: "debug", buildDir: ".build" });
}
