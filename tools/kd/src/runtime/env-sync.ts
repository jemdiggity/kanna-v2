import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { repositoryDirectory } from "./rust-cache";
import { WORKSPACE_BUILD_DIRECTORY } from "./workspace-build";

export function writeCargoConfig(repoRoot: string): string {
  const path = join(repoRoot, ".cargo", "config.toml");
  mkdirSync(join(repoRoot, ".cargo"), { recursive: true });
  writeFileSync(
    path,
    `[build]\ntarget-dir = "${WORKSPACE_BUILD_DIRECTORY}"\nbuild-dir = "${WORKSPACE_BUILD_DIRECTORY}/cargo-build"\n`
  );
  return path;
}

const MACHINE_LOCAL_CONFIG = join(".kanna", "config.local.json");

export type MachineLocalConfigSyncStatus =
  /** The primary checkout's copy was written into this worktree. */
  | "copied"
  /** No copy in the primary checkout, but this worktree has one; left alone. */
  | "kept-local"
  /** Nothing to copy anywhere. */
  | "absent"
  /** This *is* the primary checkout: source and destination are one file. */
  | "primary-checkout";

export interface MachineLocalConfigSync {
  status: MachineLocalConfigSyncStatus;
  destination: string;
  /** Absent when no primary checkout is resolvable from this repo root. */
  source?: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The working tree that owns this repository's common Git directory — the
 * checkout every worktree was forked from, and the one the operator keeps
 * machine-local files in.
 *
 * Derived from the same common-directory resolution kd uses to give every
 * worktree of a repository one identity. Undefined when that resolution lands
 * somewhere that is not a checkout's `.git` (a bare repo, a detached Git
 * directory, an unreadable `.git`), because there is no primary working tree to
 * read from in those cases.
 */
export function primaryCheckoutPath(repoRoot: string): string | undefined {
  const gitDirectory = repositoryDirectory(repoRoot);
  return basename(gitDirectory) === ".git" ? dirname(gitDirectory) : undefined;
}

/**
 * Copies the machine's `.kanna/config.local.json` from the primary checkout
 * into this worktree.
 *
 * The machine-local override layer is read from the *open* repo's working tree,
 * and a per-worktree dev instance opens its own worktree — so without this copy
 * a worktree's `kanna-server` runs the committed config while the operator's
 * machine preference sits one checkout away, unread. `git worktree add` never
 * copies ignored files, which is why this belongs in every sync rather than in
 * worktree creation.
 *
 * The primary checkout wins on every sync: it holds the machine's canonical
 * preference, so a stale worktree copy is overwritten. Absence there is not a
 * delete — a worktree-local file is the only copy of whatever it says, and
 * removing it would destroy an operator's deliberate placement to propagate
 * nothing.
 */
export function syncMachineLocalConfig(repoRoot: string): MachineLocalConfigSync {
  const destination = join(repoRoot, MACHINE_LOCAL_CONFIG);
  const primaryCheckout = primaryCheckoutPath(repoRoot);
  if (!primaryCheckout) {
    return { status: existsSync(destination) ? "kept-local" : "absent", destination };
  }

  const source = join(primaryCheckout, MACHINE_LOCAL_CONFIG);
  if (canonicalPath(source) === canonicalPath(destination)) {
    return { status: "primary-checkout", source, destination };
  }
  if (!existsSync(source)) {
    return { status: existsSync(destination) ? "kept-local" : "absent", source, destination };
  }

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { status: "copied", source, destination };
}
