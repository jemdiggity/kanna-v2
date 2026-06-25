# Staging Desktop Credential Launch Design

## Context

Testing staging currently requires signing into the desktop app after launching a
new worktree instance. Desktop auth persistence is unreliable for this workflow,
and new workspaces do not share cached Firebase Auth state anyway.

Kanna already keeps local-only developer cloud credentials under
`~/.kanna/dev/creds.toml`. That path should become a more general developer
configuration root named `~/.kanna/developer`.

## Goals

- Provide an explicit way to launch staging desktop instances with developer
  credentials.
- Keep credentials outside the repository and outside per-worktree databases.
- Make the flow work across new Kanna worktrees.
- Avoid changing normal staging launch behavior unless the operator opts in.
- Preserve the existing Firebase email/password auth path in the desktop app.

## Non-Goals

- Do not preseed Firebase Auth's private IndexedDB/local persistence format.
- Do not auto-enable credentials for every staging launch.
- Do not support production auto sign-in.
- Do not store credentials in SQLite settings tables.
- Do not expose credential values in logs, tmux commands, or kd status output.

## Developer Config Layout

The canonical developer config root is:

```text
~/.kanna/developer
```

Staging desktop credentials live at:

```text
~/.kanna/developer/staging/desktop-auth.toml
```

Expected file shape:

```toml
[desktop_auth]
email = "developer@example.com"
password = "not committed"
```

The existing cloud test credential file moves from:

```text
~/.kanna/dev/creds.toml
```

to:

```text
~/.kanna/developer/creds.toml
```

## Migration

`kd` resolves the developer config root with a safe migration:

1. If `~/.kanna/developer` exists, use it.
2. If `~/.kanna/developer` does not exist and `~/.kanna/dev` exists, rename
   `~/.kanna/dev` to `~/.kanna/developer`.
3. If both directories exist, use `~/.kanna/developer` and leave
   `~/.kanna/dev` untouched.

This keeps the existing local credential file usable without forcing a manual
move, while avoiding destructive behavior when both paths are present.

## CLI Surface

Add `--with-credentials` to staging launch paths:

```bash
./kd mobile up --staging --with-credentials
./kd mobile run --device --staging --with-credentials
./kd dev restart desktop --staging --with-credentials
```

When the flag is absent, staging launch behavior remains unchanged.

When the flag is present:

- `kd` requires `~/.kanna/developer/staging/desktop-auth.toml`.
- Missing or malformed config fails fast before starting or restarting the
  desktop process.
- The error message names the expected path and TOML shape, but never prints a
  password value.

## Runtime Flow

`kd` parses the staging desktop auth config and injects credentials only into
the desktop window environment:

```text
KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL
KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD
```

The mobile/Metro window does not receive these variables.

The desktop app consumes these variables only when all conditions are true:

- Running in a dev build.
- `KANNA_CLOUD_ENV=staging`.
- Both auto sign-in env vars are present.
- The current desktop auth state is signed out.

When those conditions are met, the desktop app calls the existing
`DesktopAuthSession.signInWithEmailPassword()` method. This preserves the
normal Firebase Auth flow, token refresh behavior, cloud publisher behavior, and
desktop relay credential publishing.

If the sign-in fails, the desktop app surfaces the existing auth error state and
does not retry in a loop.

## Security

- Credential files are local-only under `~/.kanna/developer`.
- `kd` must not print credential values.
- `kd` should avoid embedding credential values directly in shell command text
  where practical. Prefer tmux/window environment injection over inline
  `KEY=value command` prefixes for these variables.
- Auto sign-in is staging-only and dev-build-only.
- Production launches must ignore `--with-credentials` or reject it.

## Components

- `tools/kd/src/runtime/developer-config.ts`
  - Resolve and migrate the developer config root.
  - Parse staging desktop auth TOML.
  - Return sanitized errors for missing or malformed credentials.

- `tools/kd/src/runtime/cloud-creds.ts`
  - Move canonical cloud test credential path to
    `~/.kanna/developer/creds.toml`.
  - Keep legacy fallback through the developer root resolver.

- `tools/kd/src/cli.ts`
  - Parse `--with-credentials` for staging-supported commands.

- `tools/kd/src/tasks/registry.ts`
  - Thread `withCredentials` into staging mobile and desktop restart plans.

- `tools/kd/src/runtime/dev-plan.ts`
  - Add desktop-only secret env injection support.
  - Ensure mobile windows do not inherit desktop auto sign-in secrets.

- `apps/desktop/src/services/desktopAuthSdk.ts` or a small companion module
  - Read auto sign-in env vars through `read_env_var`.
  - Trigger sign-in only under the staging/dev/signed-out guard.

## Testing

- Unit-test developer config root migration for missing, legacy-only,
  canonical-only, and both-path cases.
- Unit-test staging desktop auth TOML parsing and redacted errors.
- Unit-test CLI parsing for accepted and rejected `--with-credentials`
  combinations.
- Unit-test plan construction to prove credentials go to the desktop window and
  not mobile/Metro.
- Unit-test desktop auto sign-in guards:
  - signs in for dev + staging + signed out + env present
  - does nothing when already signed in
  - does nothing outside staging
  - does nothing without credentials
  - does not retry indefinitely after failure

## Manual Verification

1. Create `~/.kanna/developer/staging/desktop-auth.toml`.
2. Run `./kd mobile run --device --staging --with-credentials`.
3. Confirm the desktop app starts signed into the configured staging account.
4. Confirm `Kanna Staging` launches on the iPhone.
5. Confirm `./kd mobile run --device --staging` without the flag does not
   auto sign in.
