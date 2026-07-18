# Expo SDK 57 Mobile OTA Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canonical mobile OTA publisher stage Expo SDK 57's processed public app config without relying on the removed `dist/expoConfig.json` export artifact.

**Architecture:** Continue using `expo export` for `metadata.json`, the Hermes bundle, and assets. Resolve the update manifest's `extra.expoClient` value through `expo config --type public --json` under the same `KANNA_APP_ENV`, validate it, and pass its bytes directly into the existing temporary update staging directory as `expoConfig.json`.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Expo CLI 57, Vitest, pnpm

---

### Task 1: Stage SDK 57 public Expo config

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.ts:1,140-175,225-245,686-715`

- [ ] **Step 1: Make test fixtures match SDK 57 and assert the supported command flow**

Remove every test write of `apps/mobile/dist/expoConfig.json`. In `builds a dry-run publish plan without uploading to GCS`, change the command assertion to:

```ts
expect(plan.commands.map((command) => command.command)).toEqual([
  "pnpm",
  "pnpm",
  "gcloud",
  "gcloud",
]);
expect(plan.commands[0]?.args).toContain("export");
expect(plan.commands[1]?.args).toEqual([
  "exec",
  "expo",
  "config",
  "--type",
  "public",
  "--json",
]);
```

In `checks git cleanliness and runs export before publishing in dry-run mode`, capture command environment and return public config only for the new config command:

```ts
const expoPublicConfig = JSON.stringify({
  name: "Kanna Staging",
  runtimeVersion: "1.0.0",
  extra: { kanna: { appEnv: "staging" } },
});
const calls: Array<{
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}> = [];
const runner: CommandRunner = {
  async run(command, args, options) {
    calls.push({ command, args, cwd: options?.cwd, env: options?.env });
    if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "pnpm" && args.includes("export")) {
      await mkdir(join(repoRoot, "apps/mobile/dist/bundles"), { recursive: true });
      await writeFile(
        join(repoRoot, "apps/mobile/dist/metadata.json"),
        JSON.stringify({
          fileMetadata: { ios: { bundle: "bundles/main.hbc", assets: [] } },
        })
      );
      await writeFile(join(repoRoot, "apps/mobile/dist/bundles/main.hbc"), "bundle");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args.includes("config")) {
      return { exitCode: 0, stdout: expoPublicConfig, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
```

After executing the dry run, assert the exact supported config call and absence of cloud access:

```ts
expect(calls[2]).toMatchObject({
  command: "pnpm",
  args: ["exec", "expo", "config", "--type", "public", "--json"],
  cwd: join(repoRoot, "apps/mobile"),
  env: { KANNA_APP_ENV: "staging" },
});
expect(calls.some((call) => call.command === "gcloud")).toBe(false);
```

In `publishes the update ID derived from the staged metadata uploaded to GCS`, replace the runner with one that distinguishes export from config and never writes the removed file:

```ts
const runner: CommandRunner = {
  async run(command, args) {
    if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "pnpm" && args.includes("export")) {
      await mkdir(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios"), { recursive: true });
      await mkdir(join(repoRoot, "apps/mobile/dist/assets"), { recursive: true });
      await writeFile(
        join(repoRoot, "apps/mobile/dist/metadata.json"),
        JSON.stringify({
          fileMetadata: {
            ios: {
              bundle: "_expo/static/js/ios/main.hbc",
              assets: [
                {
                  path: "assets/icon.png",
                  ext: "png",
                  contentType: "image/png",
                },
              ],
            },
          },
        })
      );
      await writeFile(join(repoRoot, "apps/mobile/dist/_expo/static/js/ios/main.hbc"), bundleBytes);
      await writeFile(join(repoRoot, "apps/mobile/dist/assets/icon.png"), assetBytes);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args.includes("config")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ name: "Kanna Staging", runtimeVersion: "1.0.0" }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --maxWorkers=2
```

Expected: FAIL because the plan contains only one `pnpm` command and the publish workflow still tries to copy missing `apps/mobile/dist/expoConfig.json`.

- [ ] **Step 3: Add the public-config command and pass its output into staging**

Remove `cp` from the `node:fs/promises` import. Add the supported config command next to `buildExpoExportCommand`:

```ts
function buildExpoPublicConfigCommand(
  repoRoot: string,
  environment: CloudEnvironmentName
): MobileOtaCommandPlan {
  return {
    command: "pnpm",
    args: ["exec", "expo", "config", "--type", "public", "--json"],
    cwd: join(repoRoot, "apps/mobile"),
    env: {
      KANNA_APP_ENV: environment === "staging" ? "staging" : "prod",
    },
  };
}

async function readExpoPublicConfig(
  repoRoot: string,
  environment: CloudEnvironmentName,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): Promise<Buffer> {
  const command = buildExpoPublicConfigCommand(repoRoot, environment);
  const result = await runner.run(command.command, command.args, {
    cwd: command.cwd,
    env: { ...env, ...command.env },
  });
  return Buffer.from(result.stdout);
}
```

Include `buildExpoPublicConfigCommand(input.repoRoot, input.environment)` immediately after the export command in `buildMobileOtaPublishPlan.commands`.

In `executeMobileOtaPublishWithContext`, resolve public config after export and pass it to staging:

```ts
const expoConfigBytes = await readExpoPublicConfig(
  context.repoRoot,
  environment,
  context.runner,
  context.env
);
const staged = await stageOtaUpdate({ distDir, expoConfigBytes });
```

Change staging to accept the bytes and write them directly:

```ts
async function stageOtaUpdate(input: {
  distDir: string;
  expoConfigBytes: Buffer;
}): Promise<{ path: string; updateId: string }> {
  const stagedMetadata = await buildStagedExpoMetadata(input.distDir);
  const stageRoot = await mkdtemp(join(tmpdir(), "kanna-ota-stage-"));
  const output = join(stageRoot, stagedMetadata.updateId);
  await mkdir(join(output, "bundles"), { recursive: true });
  await mkdir(join(output, "assets"), { recursive: true });

  await writeFile(join(output, stagedMetadata.bundle.targetPath), stagedMetadata.bundle.bytes);
  for (const asset of stagedMetadata.assets) {
    await writeFile(join(output, asset.targetPath), asset.bytes);
  }
  await writeFile(join(output, "metadata.json"), stagedMetadata.metadataBytes);
  await writeFile(join(output, "expoConfig.json"), input.expoConfigBytes);
  return { path: output, updateId: stagedMetadata.updateId };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --maxWorkers=2
```

Expected: PASS with the SDK 57 fixture and no `gcloud` invocation in dry-run mode.

- [ ] **Step 5: Commit the supported staging path**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "fix(kd): stage Expo public config for mobile OTA"
```

### Task 2: Reject invalid public-config output before cloud access

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.ts:710-735`

- [ ] **Step 1: Add failing command-error and malformed-JSON tests**

Add a fixture helper near `makeRepoFixture`:

```ts
async function writeMinimalSdk57Export(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, "apps/mobile/dist/bundles"), { recursive: true });
  await writeFile(
    join(repoRoot, "apps/mobile/dist/metadata.json"),
    JSON.stringify({
      fileMetadata: { ios: { bundle: "bundles/main.hbc", assets: [] } },
    })
  );
  await writeFile(join(repoRoot, "apps/mobile/dist/bundles/main.hbc"), "bundle");
}
```

Add a command-error workflow test:

```ts
it("surfaces Expo public config command failures before cloud access", async () => {
  const repoRoot = await makeRepoFixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "pnpm" && args.includes("export")) {
        await writeMinimalSdk57Export(repoRoot);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm" && args.includes("config")) {
        return { exitCode: 1, stdout: "", stderr: "config failed" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected cloud access" };
    },
  };

  await expect(
    executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    )
  ).rejects.toThrow("config failed");
  expect(calls.some((call) => call.command === "gcloud")).toBe(false);
});
```

Add a malformed-output workflow test:

```ts
it("rejects malformed Expo public config before cloud access", async () => {
  const repoRoot = await makeRepoFixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "pnpm" && args.includes("export")) {
        await writeMinimalSdk57Export(repoRoot);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "pnpm" && args.includes("config")) {
        return { exitCode: 0, stdout: "not-json", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected cloud access" };
    },
  };

  await expect(
    executeMobileOtaPublishWithContext(
      { staging: true, production: false, dryRun: true },
      { repoRoot, env: {}, runner }
    )
  ).rejects.toThrow("Expo public config command did not return valid JSON.");
  expect(calls.some((call) => call.command === "gcloud")).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --maxWorkers=2
```

Expected: FAIL because `readExpoPublicConfig` neither checks the exit code nor parses stdout.

- [ ] **Step 3: Validate the command result and JSON**

Replace the return in `readExpoPublicConfig` with:

```ts
if (result.exitCode !== 0) {
  throw new Error(
    result.stderr || result.stdout || `${command.command} ${command.args.join(" ")} failed.`
  );
}
try {
  JSON.parse(result.stdout);
} catch {
  throw new Error("Expo public config command did not return valid JSON.");
}
return Buffer.from(result.stdout);
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --maxWorkers=2
```

Expected: PASS, including both pre-cloud failure cases.

- [ ] **Step 5: Commit config validation**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "test(kd): validate mobile OTA public config"
```

### Task 3: Verify the canonical workflow

**Files:**
- Verify only: `tools/kd/src/runtime/mobile-ota.ts`
- Verify only: `tools/kd/src/runtime/mobile-ota.test.ts`
- Verify unchanged: `apps/mobile/src/mobileEnvironments.json`

- [ ] **Step 1: Run the focused OTA tests**

```bash
pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --maxWorkers=2
```

Expected: all tests PASS.

- [ ] **Step 2: Run the kd TypeScript typecheck**

```bash
pnpm --dir tools/kd run typecheck
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run the canonical staging dry run**

The publisher requires a clean worktree, so commit the implementation and plan before this check. Then run:

```bash
./kd mobile ota publish --staging --dry-run
```

Expected: Expo exports the iOS Hermes bundle/assets, Expo public config resolves successfully, the command prints `Dry run: mobile OTA update`, and no `gcloud` command runs.

- [ ] **Step 4: Confirm the runtime compatibility key did not change**

```bash
git diff origin/main -- apps/mobile/src/mobileEnvironments.json
```

Expected: no output.

- [ ] **Step 5: Inspect the final branch diff**

```bash
git status --short --branch
git diff --check origin/main
git diff --stat origin/main
```

Expected: clean worktree, no whitespace errors, and changes limited to the approved docs plus `tools/kd/src/runtime/mobile-ota.ts` and its test.
