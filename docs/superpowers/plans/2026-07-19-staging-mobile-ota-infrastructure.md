# Staging Mobile OTA Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible staging-only `kd` workflow that provisions the OTA bucket, Google APIs, signing secret, and relay IAM, then deploy and verify staging without publishing an OTA.

**Architecture:** Keep non-secret infrastructure in a new idempotent `mobile ota provision` command, keep key material in the existing `provision-secret` command, and keep doctor strictly read-only. Use the existing environment registry as the only project/bucket source of truth and parse IAM policy JSON locally instead of relying on version-sensitive `gcloud` filters.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, `pnpm`, Google Cloud Storage and Secret Manager through `kd`-managed `gcloud` subprocesses.

---

### Task 1: Add the `mobile ota provision` CLI Contract

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/cli.ts`

- [ ] **Step 1: Write the failing parser test**

Add this assertion beside the existing OTA parser assertions:

```ts
expect(parseCliArgs(["mobile", "ota", "provision", "--staging"])).toEqual({
  taskId: "mobile.ota.provision",
  input: { staging: true, production: false },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: FAIL because `mobile ota provision` is not a recognized subcommand.

- [ ] **Step 3: Add the parser and help contract**

Add the parser branch before `provision-secret`:

```ts
if (subcommand === "provision") {
  return {
    taskId: "mobile.ota.provision",
    input: parseFlagInput(otaRest, { staging: false, production: false }),
  };
}
```

Update the OTA error and general/group help text to list `provision`, and add a command-specific `mobile ota provision` help topic.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: PASS for the parser assertion and the existing OTA tests.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add tools/kd/src/cli.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "feat(kd): add mobile OTA provision command"
```

### Task 2: Provision the Staging Bucket and Relay Storage IAM

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.ts`
- Modify: `tools/kd/src/tasks/registry.ts`

- [ ] **Step 1: Write failing tests for missing and existing buckets**

Add tests that call `executeMobileOtaProvisionWithContext` with staging flags. The missing-bucket runner must return a 404 from `storage buckets describe`, return a sentinel access token from `gcloud auth print-access-token`, return the staging relay service account from `compute instances describe`, and capture all other calls. Inject a test HTTP client and assert it receives:

```ts
expect(request).toMatchObject({
  url: "https://firebasestorage.googleapis.com/v1alpha/projects/kanna-staging/defaultBucket",
  method: "POST",
  headers: { authorization: "Bearer test-access-token" },
  body: { location: "US-CENTRAL1" },
});
```

Assert this exact command sequence:

```ts
expect(calls.map(({ args }) => args)).toContainEqual([
  "services", "enable", "storage.googleapis.com", "firebasestorage.googleapis.com",
  "--project", "kanna-staging",
]);
expect(calls.map(({ args }) => args)).toContainEqual([
  "auth", "print-access-token",
]);
expect(calls.map(({ args }) => args)).toContainEqual([
  "storage", "buckets", "add-iam-policy-binding",
  "gs://kanna-staging.firebasestorage.app", "--project", "kanna-staging",
  "--member", "serviceAccount:kanna-relay-staging@kanna-staging.iam.gserviceaccount.com",
  "--role", "roles/storage.objectViewer",
]);
```

For the existing-bucket runner, return exit code 0 from describe and assert neither token acquisition nor the Firebase request occurs. Add a third test returning `PERMISSION_DENIED` from describe and assert the workflow rejects without requesting a token. Add a fourth test where Firebase returns a non-2xx response and assert the workflow stops before IAM, reports the Firebase error, and never includes the sentinel access token in the error or result message.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: FAIL because bucket/API/IAM provisioning is not implemented.

- [ ] **Step 3: Implement the idempotent provisioning workflow**

Add the public input type:

```ts
export type MobileOtaProvisionInput = Pick<MobileOtaInput, "staging" | "production">;
```

Extend `MobileOtaContext` with an optional injected HTTP request function so tests never access the network. Implement `executeMobileOtaProvisionWithContext` with this order:

```ts
const environment = resolveMobileOtaEnvironment(input, "provision");
const identity = resolveKdEnvironment(cloudEnvironmentToKdEnvironment(environment));
const projectId = identity.firebaseProjectId;
const bucket = identity.otaBucket;
if (!bucket || !identity.gceVmName) throw new Error(`Mobile OTA provisioning is not configured for ${environment}.`);

await mustRun(context.runner, "gcloud", [
  "services", "enable", "storage.googleapis.com", "firebasestorage.googleapis.com",
  "--project", projectId,
], context.repoRoot, context.env);
```

Describe `gs://${bucket}`. When `isNotFoundFailure(result)` returns true, run `gcloud auth print-access-token`, keep the token only in memory, and POST `{ "location": "US-CENTRAL1" }` to `https://firebasestorage.googleapis.com/v1alpha/projects/${projectId}/defaultBucket` using the injected request function or global `fetch`. Throw a sanitized error containing only HTTP status and response body for non-2xx responses. Throw the summarized command failure for all other nonzero describe results. Resolve the relay VM service account using the same compute command as doctor and bind `roles/storage.objectViewer` on the bucket. Return a message containing environment, project, bucket, and service-account email only.

Implement `isNotFoundFailure` by inspecting normalized stderr/stdout for `not found`, `not_found`, or `404`; do not classify permission or API-disabled errors as absence.

Add the registry schema and task:

```ts
const mobileOtaProvisionInputSchema = z.object({
  production: z.boolean().default(false),
  staging: z.boolean().default(false)
});
```

```ts
{
  id: "mobile.ota.provision",
  description: "Provision Kanna mobile OTA bucket and relay storage access.",
  inputSchema: mobileOtaProvisionInputSchema,
  execute: async (_context, input) => {
    const context = await resolveDefaultContext(process.env);
    return executeMobileOtaProvisionWithContext(mobileOtaProvisionInputSchema.parse(input), {
      repoRoot: context.repoRoot,
      env: context.env,
      runner: nodeCommandRunner
    });
  }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: all OTA runtime tests PASS.

- [ ] **Step 5: Commit bucket provisioning**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts tools/kd/src/tasks/registry.ts
git commit -m "feat(kd): provision mobile OTA storage"
```

### Task 3: Harden Signing-Secret Provisioning

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.ts`

- [ ] **Step 1: Write failing tests for API enablement and inspection errors**

Extend the existing secret test to assert that the first cloud mutation is:

```ts
["services", "enable", "secretmanager.googleapis.com", "--project", "kanna-staging"]
```

Make its describe response a 404. Add a test where describe returns `PERMISSION_DENIED` and assert the workflow rejects without calling `secrets create` or `secrets versions add`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: FAIL because Secret Manager is not enabled and every describe failure is currently treated as a missing secret.

- [ ] **Step 3: Enable Secret Manager and distinguish absence from failure**

Before describe, add:

```ts
await mustRun(context.runner, "gcloud", [
  "services", "enable", "secretmanager.googleapis.com", "--project", projectId,
], context.repoRoot, context.env);
```

Create the secret only for `isNotFoundFailure(describe)`. For any other nonzero result, throw `new Error(summarizeCommandFailure(describe))`. Preserve `--data-file input.keyPath` and never include file contents in command messages.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: all OTA runtime tests PASS.

- [ ] **Step 5: Commit secret hardening**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "fix(kd): harden OTA secret provisioning"
```

### Task 4: Make Doctor IAM Checks Portable and Read-Only

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.ts`

- [ ] **Step 1: Change doctor tests to return policy JSON and assert portable commands**

Return policies shaped like:

```ts
JSON.stringify({
  bindings: [{
    role: "roles/storage.objectViewer",
    members: ["serviceAccount:relay-sa@kanna-staging.iam.gserviceaccount.com"],
  }],
})
```

Assert both IAM calls use `--format=json`, contain no `--filter` or `--flatten`, and that the existing no-write assertions remain true. Add a negative test whose policy has the member under a different role and assert doctor reports `FAIL GCS IAM`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: FAIL because doctor still uses filtered text output.

- [ ] **Step 3: Parse exact IAM bindings locally**

Define:

```ts
interface IamPolicy {
  bindings?: Array<{ role?: string; members?: string[] }>;
}
```

Change `addIamPolicyCheck` to accept `expectedRole` and `expectedMember`, parse stdout as JSON, and pass only when one binding has the expected role and includes the expected member. On invalid JSON, return a failed check with the command output summary. Replace both IAM commands with unfiltered `--format=json` invocations.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts`

Expected: all OTA runtime tests PASS and no test runner warnings.

- [ ] **Step 5: Commit doctor hardening**

```bash
git add tools/kd/src/runtime/mobile-ota.ts tools/kd/src/runtime/mobile-ota.test.ts
git commit -m "fix(kd): make OTA IAM doctor portable"
```

### Task 5: Document and Verify the Canonical Workflow

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/specs/mobile-ota-updates.md`
- Modify: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Add a failing help-text assertion**

Add:

```ts
await expect(runCli(["mobile", "ota", "provision", "--help"])).resolves.toBe(0);
expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Usage: kd mobile ota provision"));
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run: `pnpm --dir tools/kd test -- tests/cli.test.ts`

Expected: FAIL until the command-specific help topic is present.

- [ ] **Step 3: Update help and operations documentation**

Document this staging sequence verbatim in `AGENTS.md` and the OTA spec:

```bash
./kd mobile ota provision --staging
./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
./kd cloud deploy --staging --relay
./kd mobile ota doctor --staging
./kd mobile ota status --staging
```

State that provisioning is idempotent, doctor/status are read-only, production requires an explicit production flag, and publishing remains a separate operation. Update any stale hard-coded runtime-version prose to say the value comes from `mobileEnvironments.json`.

- [ ] **Step 4: Run focused and broader verification**

Run:

```bash
pnpm --dir tools/kd test -- src/runtime/mobile-ota.test.ts tests/cli.test.ts
pnpm --dir tools/kd typecheck
pnpm --dir tools/kd test
git diff --check
```

Expected: every command exits 0 with zero failing tests and no diff whitespace errors.

- [ ] **Step 5: Commit documentation and final repository changes**

```bash
git add AGENTS.md docs/specs/mobile-ota-updates.md tools/kd/src tools/kd/tests docs/superpowers/plans/2026-07-19-staging-mobile-ota-infrastructure.md
git commit -m "docs: document staging OTA provisioning"
```

### Task 6: Provision, Deploy, and Capture Staging Evidence

**Files:**
- No source files expected; staging cloud resources only.

- [ ] **Step 1: Confirm the worktree is clean and production commands are absent**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: no dirty files; commits contain only the approved staging OTA workflow and documentation.

- [ ] **Step 2: Provision staging non-secret infrastructure**

Run: `./kd mobile ota provision --staging`

Expected: exit 0; output names `kanna-staging`, `kanna-staging.firebasestorage.app`, and the staging relay service account.

- [ ] **Step 3: Provision the existing key without exposing it**

Run: `./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"`

Expected: exit 0; output names the secret and key id but contains no PEM payload.

- [ ] **Step 4: Deploy Firebase and the staging relay through the canonical workflow**

Run: `./kd cloud deploy --staging --relay`

Expected: exit 0; Firebase services deploy and the staging relay container restarts with the staging bucket and mounted signing key.

- [ ] **Step 5: Run fresh read-only evidence commands**

Run:

```bash
./kd mobile ota doctor --staging
./kd mobile ota status --staging
```

Expected: infrastructure, secret, relay service account, secret IAM, and GCS IAM checks pass. If there is no existing SDK 57-compatible update, pointer/manifest remain failed and status remains nonzero; record that precisely as the publisher-task/human-only blocker rather than publishing an OTA.

- [ ] **Step 6: Complete repository review and PR pipeline without publishing**

Inspect the final diff and use Kanna's task workflow to advance through review and PR as explicitly requested. Do not run `mobile ota publish`, do not invoke any production flag, and do not install or launch a physical device. The PR summary must distinguish repository verification from the remaining no-published-update blocker.
