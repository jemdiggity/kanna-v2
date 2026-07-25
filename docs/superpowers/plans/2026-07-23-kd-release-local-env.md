# Kd Release Local Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kd release ship` and `kd release promote` load repository-local release defaults from the primary checkout's ignored `.env.release.local` file.

**Architecture:** A focused runtime helper resolves the Git common directory, reads and parses `.env.release.local` from the primary checkout, and merges it underneath the inherited environment. The release task registry applies the helper only around ship and promote operations, leaving every other kd command unchanged.

**Tech Stack:** TypeScript, Node.js `util.parseEnv`, Git, Vitest, pnpm

---

## File map

- Create `tools/kd/src/runtime/release-env.ts`: resolve the primary checkout and load the release dotenv file without mutating `process.env`.
- Create `tools/kd/tests/release-env.test.ts`: unit coverage for location, parsing, precedence, absence, and failures.
- Modify `tools/kd/src/tasks/registry.ts`: wrap release ship and promote with the release-local environment.
- Modify `tools/kd/tests/tasks.test.ts`: prove the registry wrapper passes merged values to release operations.
- Modify `.gitignore`: prevent `.env.release.local` from being committed.
- Modify `docs/dev/release.md`: document setup, lookup, and precedence.
- Create `/Users/jeremyhale/.kanna/repos/kanna-7/.env.release.local` locally: store only `APPLE_KEYCHAIN_PROFILE=kanna-notarization` with mode `0600`; this file remains untracked.

### Task 1: Release environment loader

**Files:**
- Create: `tools/kd/src/runtime/release-env.ts`
- Create: `tools/kd/tests/release-env.test.ts`

- [ ] **Step 1: Write failing loader tests**

Create `tools/kd/tests/release-env.test.ts` with a fake command runner and temporary directories:

```ts
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadReleaseEnvironment } from "../src/runtime/release-env";
import type { CommandRunner } from "../src/runtime/process";

function gitCommonDirRunner(commonDir: string, exitCode = 0): CommandRunner {
  return {
    async run(command, args, options) {
      expect(command).toBe("git");
      expect(args).toEqual(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      expect(options?.cwd).toBeDefined();
      return {
        exitCode,
        stdout: exitCode === 0 ? `${commonDir}\n` : "",
        stderr: exitCode === 0 ? "" : "not a git repository"
      };
    }
  };
}

describe("release environment", () => {
  it("loads the primary checkout file for a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    const primary = join(root, "repo");
    const worktree = join(primary, ".kanna-worktrees", "task-123");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(primary, ".env.release.local"),
      'APPLE_KEYCHAIN_PROFILE="kanna-notarization"\nRELEASE_DEFAULT=file\n'
    );

    const env = await loadReleaseEnvironment({
      repoRoot: worktree,
      env: { PATH: "/usr/bin" },
      runner: gitCommonDirRunner(join(primary, ".git"))
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("kanna-notarization");
    expect(env.RELEASE_DEFAULT).toBe("file");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets inherited environment values override file defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".env.release.local"), "APPLE_KEYCHAIN_PROFILE=file-profile\n");

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      env: { APPLE_KEYCHAIN_PROFILE: "shell-profile" },
      runner: gitCommonDirRunner(join(root, ".git"))
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
  });

  it("returns an equivalent copy when the file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const inherited = { PATH: "/usr/bin" };

    const env = await loadReleaseEnvironment({
      repoRoot: root,
      env: inherited,
      runner: gitCommonDirRunner(join(root, ".git"))
    });

    expect(env).toEqual(inherited);
    expect(env).not.toBe(inherited);
  });

  it("fails with the file path when dotenv syntax is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const envPath = join(root, ".env.release.local");
    await writeFile(envPath, "BROKEN LINE\n");

    await expect(
      loadReleaseEnvironment({
        repoRoot: root,
        env: {},
        runner: gitCommonDirRunner(join(root, ".git"))
      })
    ).rejects.toThrow(envPath);
  });

  it("fails with the file path when the file cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
    await mkdir(join(root, ".git"));
    const envPath = join(root, ".env.release.local");
    await writeFile(envPath, "APPLE_KEYCHAIN_PROFILE=profile\n");
    await chmod(envPath, 0o000);

    try {
      await expect(
        loadReleaseEnvironment({
          repoRoot: root,
          env: {},
          runner: gitCommonDirRunner(join(root, ".git"))
        })
      ).rejects.toThrow(envPath);
    } finally {
      await chmod(envPath, 0o600);
    }
  });

  it("fails clearly when Git cannot resolve the primary checkout", async () => {
    await expect(
      loadReleaseEnvironment({
        repoRoot: "/not-a-repo",
        env: {},
        runner: gitCommonDirRunner("", 128)
      })
    ).rejects.toThrow("not a git repository");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir tools/kd test -- release-env.test.ts
```

Expected: FAIL because `../src/runtime/release-env` does not exist.

- [ ] **Step 3: Implement the minimal loader**

Create `tools/kd/src/runtime/release-env.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { CommandRunner } from "./process";

export const RELEASE_ENV_FILE = ".env.release.local";

export interface LoadReleaseEnvironmentInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

function validateDotenv(source: string, envPath: string): void {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) {
      throw new Error(`Invalid dotenv assignment at ${envPath}:${index + 1}`);
    }
    const value = assignment[1] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !value.slice(1).endsWith(quote)) {
      throw new Error(`Unterminated quoted value at ${envPath}:${index + 1}`);
    }
  }
}

async function resolvePrimaryRepoRoot(input: LoadReleaseEnvironmentInput): Promise<string> {
  const result = await input.runner.run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: input.repoRoot, env: input.env }
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to resolve the Git common directory.");
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new Error("Git returned an empty common directory.");
  }
  return dirname(commonDir);
}

export async function loadReleaseEnvironment(
  input: LoadReleaseEnvironmentInput
): Promise<NodeJS.ProcessEnv> {
  const primaryRoot = await resolvePrimaryRepoRoot(input);
  const envPath = join(primaryRoot, RELEASE_ENV_FILE);
  if (!existsSync(envPath)) {
    return { ...input.env };
  }

  try {
    const source = readFileSync(envPath, "utf8");
    validateDotenv(source, envPath);
    const fileEnv = parseEnv(source);
    const inherited = Object.fromEntries(
      Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return { ...fileEnv, ...inherited };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load release environment ${envPath}: ${message}`);
  }
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir tools/kd test -- release-env.test.ts
```

Expected: six tests PASS. If the unreadable-file test is ineffective under the current user, replace it with a directory at `envPath` so `readFileSync` deterministically throws `EISDIR`.

- [ ] **Step 5: Commit the loader**

```bash
git add tools/kd/src/runtime/release-env.ts tools/kd/tests/release-env.test.ts
git commit -m "feat(kd): load repo-local release environment"
```

### Task 2: Apply the environment only to ship and promote

**Files:**
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/tests/tasks.test.ts`

- [ ] **Step 1: Write a failing registry-wrapper test**

Add `loadReleaseTaskEnvironment` to the import from `../src/tasks/registry` in
`tools/kd/tests/tasks.test.ts`, then add:

```ts
it("loads repo-local defaults underneath inherited release variables", async () => {
  const primary = await mkdtemp(join(tmpdir(), "kanna-release-task-"));
  const worktree = join(primary, ".kanna-worktrees", "task-123");
  await mkdir(worktree, { recursive: true });
  await writeFile(
    join(primary, ".env.release.local"),
    "APPLE_KEYCHAIN_PROFILE=file-profile\nRELEASE_DEFAULT=file\n"
  );
  const runner: CommandRunner = {
    async run(command, args) {
      expect(command).toBe("git");
      expect(args).toEqual(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      return { exitCode: 0, stdout: `${join(primary, ".git")}\n`, stderr: "" };
    }
  };

  const env = await loadReleaseTaskEnvironment(
    {
      repoRoot: worktree,
      env: { APPLE_KEYCHAIN_PROFILE: "shell-profile" }
    },
    runner
  );

  expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
  expect(env.RELEASE_DEFAULT).toBe("file");
});
```

- [ ] **Step 2: Run the registry test and verify it fails**

Run:

```bash
pnpm --dir tools/kd test -- tasks.test.ts
```

Expected: FAIL because `loadReleaseTaskEnvironment` is not exported.

- [ ] **Step 3: Add the registry wrapper and call it from ship and promote**

In `tools/kd/src/tasks/registry.ts`, import the loader:

```ts
import { loadReleaseEnvironment } from "../runtime/release-env";
```

Add the focused exported wrapper near the other executor helpers:

```ts
export async function loadReleaseTaskEnvironment(
  context: Pick<KdContext, "repoRoot" | "env">,
  runner: CommandRunner
): Promise<NodeJS.ProcessEnv> {
  return loadReleaseEnvironment({
    repoRoot: context.repoRoot,
    env: context.env,
    runner
  });
}
```

In `release.ship`, load the merged environment after resolving context:

```ts
const context = await resolveDefaultContext(process.env);
const releaseEnv = await loadReleaseTaskEnvironment(context, nodeCommandRunner);
const result = await shipRelease({
  repoRoot: context.repoRoot,
  bump,
  archLabels: archLabels.length > 0 ? archLabels : ["arm64", "x86_64"],
  environment,
  release: parsed.release,
  dryRun: parsed.dryRun,
  rollbackTo: parsed.rollbackTo,
  sourceBranch: parsed.branch,
  env: releaseEnv,
  runner: nodeCommandRunner
});
```

Apply the same pattern in `release.promote`, changing only `env: context.env` to
`env: releaseEnv`. Do not modify `release.cut`, `release.status`, or unrelated
task definitions.

- [ ] **Step 4: Run focused registry and release tests**

Run:

```bash
pnpm --dir tools/kd test -- tasks.test.ts release.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit registry integration**

```bash
git add tools/kd/src/tasks/registry.ts tools/kd/tests/tasks.test.ts
git commit -m "feat(kd): apply local env to release commands"
```

### Task 3: Ignore, document, and provision the local file

**Files:**
- Modify: `.gitignore`
- Modify: `docs/dev/release.md`
- Create locally, untracked: `/Users/jeremyhale/.kanna/repos/kanna-7/.env.release.local`

- [ ] **Step 1: Add the ignore rule and documentation**

Add this repository-root rule to `.gitignore`:

```gitignore
/.env.release.local
```

Add this section after the desktop shipping examples in `docs/dev/release.md`:

```markdown
### Local release environment

`kd release ship` and `kd release promote` load optional release defaults from
`.env.release.local` in the primary repository checkout. The same file is used
from every linked worktree. Explicitly exported environment variables override
file values.

Store notarization credentials in macOS Keychain:

```sh
xcrun notarytool store-credentials kanna-notarization
```

Then create the ignored local file with only the profile name:

```dotenv
APPLE_KEYCHAIN_PROFILE=kanna-notarization
```

Keep the file mode at `0600`. Do not store an Apple app-specific password in
the file.
```

- [ ] **Step 2: Verify the tracked documentation changes**

Run:

```bash
git diff --check
rg -n "env.release.local|APPLE_KEYCHAIN_PROFILE" .gitignore docs/dev/release.md
```

Expected: no whitespace errors; both files describe the new release-local
configuration.

- [ ] **Step 3: Commit the tracked documentation**

```bash
git add .gitignore docs/dev/release.md
git commit -m "docs: document local release environment"
```

- [ ] **Step 4: Create the ignored primary-checkout file securely**

Resolve the primary checkout via `git rev-parse --path-format=absolute
--git-common-dir`, create `.env.release.local` there with:

```dotenv
APPLE_KEYCHAIN_PROFILE=kanna-notarization
```

Use the file-editing tool rather than shell redirection, then run:

```bash
chmod 600 /Users/jeremyhale/.kanna/repos/kanna-7/.env.release.local
git check-ignore -v /Users/jeremyhale/.kanna/repos/kanna-7/.env.release.local
stat -f '%Sp %N' /Users/jeremyhale/.kanna/repos/kanna-7/.env.release.local
```

Expected: `.gitignore` matches the file and its mode is `-rw-------`.

### Task 4: Full verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run all kd tests**

Run:

```bash
pnpm --dir tools/kd test
```

Expected: all Vitest suites PASS with zero failures.

- [ ] **Step 2: Run kd typecheck**

Run:

```bash
pnpm --dir tools/kd typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run repository tests**

Run:

```bash
pnpm test
```

Expected: all repository test suites PASS. If an unrelated process-heavy suite
is excluded by the canonical command, report that exclusion rather than
starting it manually.

- [ ] **Step 4: Verify final repository state**

Run:

```bash
git status --short --branch
git log --oneline --max-count=5
```

Expected: no uncommitted tracked changes; `.env.release.local` remains ignored
and absent from commits.

- [ ] **Step 5: Commit any verification-driven fixes**

If verification required code or test corrections, commit only those focused
changes:

```bash
git add tools/kd/src/runtime/release-env.ts tools/kd/tests/release-env.test.ts \
  tools/kd/src/tasks/registry.ts tools/kd/tests/tasks.test.ts \
  .gitignore docs/dev/release.md
git commit -m "fix(kd): correct local release environment handling"
```

If no corrections were needed, do not create an empty commit.
