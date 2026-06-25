# Staging Desktop Credential Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Launch staging desktop dev instances with opt-in local credentials and have the desktop app auto sign in without exposing secrets in command text.

**Architecture:** Add a kd developer-config helper for `~/.kanna/developer`, parse staging desktop credentials from TOML, thread `--with-credentials` through supported staging commands, and inject secret env vars only into desktop tmux window environments. Add a desktop auth companion that reads those env vars through Tauri, gates auto sign-in to dev + staging + signed-out state, and invokes the existing email/password session method once.

**Tech Stack:** TypeScript, Vitest, Vue desktop frontend, Firebase Auth, kd task runner.

---

### Task 1: Developer Config And Credential Parsing

**Files:**
- Create: `tools/kd/src/runtime/developer-config.ts`
- Test: `tools/kd/tests/developer-config.test.ts`
- Modify: `tools/kd/src/runtime/cloud-creds.ts`
- Test: `tools/kd/tests/cloud-creds.test.ts`

- [x] **Step 1: Write failing tests**

Add tests that cover canonical root resolution, legacy `~/.kanna/dev` migration, both-path handling, staging desktop credential parsing, redacted missing/malformed errors, and the new cloud credential path.

- [x] **Step 2: Run red tests**

Run: `pnpm --dir tools/kd test -- developer-config.test.ts cloud-creds.test.ts`
Expected: FAIL because `developer-config.ts` does not exist and `cloudTestCredsPath()` still points to `~/.kanna/dev/creds.toml`.

- [x] **Step 3: Implement developer config helpers**

Create `resolveDeveloperConfigRoot()`, `stagingDesktopAuthPath()`, `parseStagingDesktopAuth()`, and `readStagingDesktopAuth()` using `node:fs`, `node:os`, `node:path`, and `smol-toml`. Error messages should name paths and expected TOML table/fields, but never include password values.

- [x] **Step 4: Migrate cloud credential root**

Update `cloudTestCredsPath()` to use the developer root resolver so the canonical path is `~/.kanna/developer/creds.toml`, with safe legacy migration when only `~/.kanna/dev` exists.

- [x] **Step 5: Run green tests**

Run: `pnpm --dir tools/kd test -- developer-config.test.ts cloud-creds.test.ts`
Expected: PASS.

### Task 2: kd CLI And Runtime Credential Injection

**Files:**
- Modify: `tools/kd/src/cli.ts`
- Test: `tools/kd/tests/cli.test.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Test: `tools/kd/tests/tasks.test.ts`
- Modify: `tools/kd/src/runtime/dev-plan.ts`
- Test: `tools/kd/tests/dev-plan.test.ts`

- [x] **Step 1: Write failing CLI tests**

Add assertions that `--with-credentials` parses for `mobile up --staging`, `mobile run --device --staging`, and `dev restart desktop --staging`, and that production/non-staging uses reject it.

- [x] **Step 2: Run CLI red test**

Run: `pnpm --dir tools/kd test -- cli.test.ts`
Expected: FAIL with `Unknown flag: --with-credentials`.

- [x] **Step 3: Implement CLI parsing**

Add `--with-credentials` to the boolean flag map as `withCredentials`. Allow it only on staging mobile up, staging mobile run, and staging desktop restart. Reject it for production and for local dev commands with clear errors.

- [x] **Step 4: Write failing plan/task tests**

Add tests showing credential env vars are on the desktop window `env`, absent from mobile window `env`, absent from command strings, and loaded from `~/.kanna/developer/staging/desktop-auth.toml` when the staging flag is present.

- [x] **Step 5: Run plan/task red tests**

Run: `pnpm --dir tools/kd test -- dev-plan.test.ts tasks.test.ts`
Expected: FAIL because no `withCredentials` schema or desktop-only secret env exists.

- [x] **Step 6: Implement runtime wiring**

Extend kd zod schemas with `withCredentials`, add a small loader that calls `readStagingDesktopAuth()` only when staging + withCredentials is requested, and pass a `desktopSecretEnv` object into `buildDevPlan()`. `buildDevPlan()` merges those secrets into the desktop window `env` but not `sharedEnv` or shell command prefixes.

- [x] **Step 7: Run green kd tests**

Run: `pnpm --dir tools/kd test -- cli.test.ts dev-plan.test.ts tasks.test.ts developer-config.test.ts cloud-creds.test.ts`
Expected: PASS.

### Task 3: Desktop Auto Sign-In Consumption

**Files:**
- Create: `apps/desktop/src/services/desktopAutoSignIn.ts`
- Test: `apps/desktop/src/services/desktopAutoSignIn.test.ts`
- Modify: `apps/desktop/src/App.vue`
- Optionally modify: `apps/desktop/src/services/desktopAuthSdk.ts`

- [x] **Step 1: Write failing desktop auto sign-in tests**

Add unit tests for dev + staging + signed-out + both env vars signs in, already signed in does nothing, non-staging does nothing, missing credentials does nothing, and a failed attempt is not retried.

- [x] **Step 2: Run desktop red test**

Run: `pnpm --dir apps/desktop test -- desktopAutoSignIn.test.ts`
Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement desktop auto sign-in helper**

Create a helper that reads `KANNA_CLOUD_ENV`, `KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL`, and `KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD` through injected `readEnv`, requires `dev === true`, requires staging, requires signed-out state, and invokes `session.signInWithEmailPassword()` once per process/session.

- [x] **Step 4: Wire App.vue**

After `session.initialize()` and subscription setup in `initializeDesktopCloudAuth()`, call the helper with `readEnv: (name) => invoke("read_env_var", { name })`, `dev: import.meta.env.DEV`, `session`, and `getState: () => desktopAuthState.value`.

- [x] **Step 5: Run desktop green tests**

Run: `pnpm --dir apps/desktop test -- desktopAutoSignIn.test.ts desktopAuth.test.ts desktopAuthSdk.test.ts`
Expected: PASS.

### Task 4: Verification

**Files:**
- No new files.

- [x] **Step 1: Run focused kd tests**

Run: `pnpm --dir tools/kd test -- cli.test.ts developer-config.test.ts cloud-creds.test.ts dev-plan.test.ts tasks.test.ts`
Expected: PASS.

- [x] **Step 2: Run focused desktop tests**

Run: `pnpm --dir apps/desktop test -- desktopAutoSignIn.test.ts desktopAuth.test.ts desktopAuthSdk.test.ts PreferencesPanel.account.test.ts`
Expected: PASS.

- [x] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff --check`
Expected: No whitespace errors; changes match the spec only.

- [x] **Step 4: Commit**

Commit only the implementation and plan files. Leave unrelated existing worktree changes, including `Cargo.lock`, untouched unless they were modified by this implementation.
