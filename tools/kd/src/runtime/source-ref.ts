import type { CommandRunner } from "./process";

/**
 * The source commit a tree-consuming command builds from.
 *
 * `kd cloud deploy --relay` and `kd mobile archive` both build whatever the
 * working tree contains — Cloud Build uploads the directory, Xcode archives the
 * checkout — so the commit they ship is whatever happens to be checked out, not
 * whatever the operator had in mind. Resolving an explicit `--ref` makes that
 * intent a required argument and records the resolved commit in the result.
 */
export interface ResolvedSourceRef {
  /** The ref as requested, or `HEAD` when none was given. */
  ref: string;
  /** Full commit sha the ref resolves to. */
  commit: string;
  /** Short commit sha, for human-readable output and the relay health payload. */
  shortCommit: string;
}

export interface ResolveSourceRefInput {
  repoRoot: string;
  runner: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** The `--ref` value, when the operator passed one. */
  ref?: string;
  /** Production builds must name their source explicitly. */
  requireRef: boolean;
  /** Command name used in error messages, e.g. `cloud deploy`. */
  command: string;
}

const SHORT_COMMIT_LENGTH = 12;

/**
 * Resolve the source a tree-consuming command will actually build.
 *
 * These commands consume the working tree rather than the ref, so this both
 * refuses a dirty tree and requires that the named ref is the one checked out.
 * A temporary detached worktree would be stronger, but both call sites build
 * with the local toolchain against installed workspace dependencies, so cutting
 * a throwaway worktree would mean a full install per deploy.
 */
export async function resolveSourceRef(input: ResolveSourceRefInput): Promise<ResolvedSourceRef> {
  const requested = input.ref?.trim();
  if (!requested && input.requireRef) {
    throw new Error(
      `${input.command} --production requires --ref <branch|tag|sha>. ` +
        "The build consumes the working tree, so the source commit must be named explicitly."
    );
  }

  const status = await input.runner.run("git", ["status", "--porcelain"], {
    cwd: input.repoRoot,
    env: input.env
  });
  if (status.exitCode !== 0) {
    throw new Error(status.stderr || status.stdout || "Failed to inspect git worktree status.");
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `Refusing to run ${input.command} from a dirty git worktree: the build consumes the working ` +
        "tree, not the ref. Commit or stash changes first."
    );
  }

  const head = await resolveCommit(input, "HEAD");
  if (!requested) {
    return toResolvedSourceRef("HEAD", head);
  }

  const commit = await resolveCommit(input, requested);
  if (commit !== head) {
    throw new Error(
      `${input.command} builds from the working tree, but --ref ${requested} (${commit}) is not ` +
        `checked out; HEAD is ${head}. Check the ref out first: git checkout ${requested}`
    );
  }
  return toResolvedSourceRef(requested, commit);
}

function toResolvedSourceRef(ref: string, commit: string): ResolvedSourceRef {
  return { ref, commit, shortCommit: commit.slice(0, SHORT_COMMIT_LENGTH) };
}

async function resolveCommit(input: ResolveSourceRefInput, ref: string): Promise<string> {
  const result = await input.runner.run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: input.repoRoot,
    env: input.env
  });
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Failed to resolve git ref ${ref} to a commit in ${input.repoRoot}.`);
  }
  return commit;
}

/** Describe the resolved source for human-readable command output. */
export function formatSourceRef(source: ResolvedSourceRef): string {
  return `Source: ${source.ref} (${source.shortCommit})`;
}
