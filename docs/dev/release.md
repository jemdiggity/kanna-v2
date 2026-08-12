# Release & Deployment

Kanna ships four things: the desktop app (DMG + self-updater manifest), the
mobile app (App Store builds + self-hosted OTA updates), the relay service, and
Firebase cloud services. Everything goes through `kd`.

## Versioning

The root `VERSION` file is the single source of truth for the packaged desktop
app version. `./kd release ship --release` updates `VERSION`, `tauri.conf.json`,
and Rust package metadata, commits, tags `vX.Y.Z`, and publishes a GitHub
release. `VERSION` governs the packaged desktop app only — workspace
`package.json` versions play no part in it (app-related packages sit at
`0.0.0`; a few services version independently, e.g. `services/relay` at
`0.1.0`). The desktop app reads `VERSION` at compile time via `build.rs`.

The mobile App Store marketing version is independent and lives in
`apps/mobile/VERSION`. Native mobile builds resolve it in this order: an
explicit `KANNA_APP_VERSION`, `apps/mobile/VERSION`, then the root `VERSION` as
a compatibility fallback. An empty or malformed mobile version fails the build
instead of silently using the desktop version. This marketing version is
separate from the OTA `runtimeVersion` and the iOS build number.

## Desktop: dev path vs. release path

These are intentionally separate:

- **Dev path** — `./kd dev up` (Tauri + Vite). Local iteration, E2E runs.
- **Release path** — Bazel. Deterministic frontend dist
  (`//apps/desktop:dist`), deterministic Rust/Tauri binary
  (`//apps/desktop/src-tauri:kanna_desktop`), unsigned `.app` assembly via
  `rules_tauri`, then signing, DMG creation, and notarization.

```sh
bazel build //:kanna_app_arm64            # unsigned app
bazel build -c opt //:release_apps        # release-shaped apps
```

These Bazel targets are useful for development diagnostics only. Shipping and
notarization always go through `kd`, which owns credential preflight and the
release safety checks. The checked-in `.bazelrc` shares a disk/repository cache
across worktrees under `~/Library/Caches/kanna-bazel/` without sharing the live
output tree.

Because Kanna is distributed as a signed macOS app, all dependencies must be
vendored or statically linked (e.g. `git2` vendors libgit2 + OpenSSL) — never
rely on Homebrew or other machine-local libraries.

### Shipping

```sh
./kd release ship --dry-run    # build/sign artifacts without publishing
./kd release ship --release    # tag, publish, upload updater manifest
```

**Staging channel:** `./kd release ship --staging --release` builds
`X.Y.Z-staging.N` without persisting a version bump, publishes an immutable
prerelease tagged `vX.Y.Z-staging.N`, and repoints only `latest-staging.json`
on the `desktop-staging` pointer release. Roll back by repointing:
`./kd release ship --staging --rollback-to <version>`.

### Local release environment

Notarization and updater signing use credentials stored in explicitly selected,
file-based macOS Keychains. Run the notarization setup once per release machine:

```sh
./kd release setup-notarization
```

The command defaults to profile `kanna-notarization` in the current user's
default login Keychain. It securely prompts through `notarytool`, validates the
credential with Apple before saving it, then writes only these non-secret
selectors to `~/.kanna/.env.release.local` with mode `0600`:

```dotenv
APPLE_KEYCHAIN_PROFILE="kanna-notarization"
APPLE_KEYCHAIN_PATH="/Users/example/Library/Keychains/login.keychain-db"
```

Use `--profile <name>` or `--keychain <absolute-path>` when a different named
profile or file-based Keychain is required. Existing credentials saved with
`notarytool --sync` live in the data-protection Keychain and cannot be copied or
extracted; run the setup command and enter the credential once so it is saved
in the selected file-based Keychain. Setup writes only
`~/.kanna/.env.release.local`; it does not inspect or modify repository files.

`kd release ship` and non-dry-run promotions validate that exact profile and
Keychain using `notarytool history` before starting the release build. Missing
config, a missing Keychain file or profile, a locked/inaccessible Keychain, and
credentials rejected by Apple produce distinct safe diagnostics. If the login
Keychain is locked, unlock it normally and retry; never put its password in an
environment file.

The updater private key also has a one-time migration step. Put its public key
in the machine-global release file:

```dotenv
KANNA_UPDATER_PUBKEY="<public key>"
```

Then import the private key into the user's default file-based Keychain:

```sh
./kd release setup-updater-key
```

Use `--service <name>` or `--account <name>` to select a different
generic-password item. Setup loads `~/.kanna/.env.release.local` and delegates
secret entry directly to `security`'s native terminal prompt; paste the
single-line Tauri private key there. kd never reads a source key file or passes
the entered material in argv, stdin, logs, or its result. Prompt mode works only
with the user's current default file-based Keychain, so `--keychain` must name
that same file; kd fails rather than changing the global default. After the
prompt, setup reads the exact selected item back, proves it matches
`KANNA_UPDATER_PUBKEY`, and records only these selectors in that file:

```dotenv
KANNA_UPDATER_KEYCHAIN_SERVICE="build.kanna.updater-key"
KANNA_UPDATER_KEYCHAIN_ACCOUNT="tauri-updater-signing-key"
KANNA_UPDATER_KEYCHAIN_PATH="/Users/example/Library/Keychains/login.keychain-db"
```

Back up the original private key somewhere durable and offline. Losing this key
makes existing installations impossible to update. Normal `kd release ship` runs read
the private key only from the configured Keychain item and pass it to the Tauri
signer through its child-process environment; key material and passwords never
belong in process arguments, release config, or command output. Setup is
machine-serialized with a kernel-backed macOS file lock and never overwrites an
existing valid item. If validation or selector publication fails after the
native prompt, kd retains the new item rather than risk deleting a concurrent
replacement; retry with the same selector after a publication failure, or use a
fresh service/account after a key mismatch. Ships resolve the actual Keychain
item and verify it against the public key before changing version files or
starting Bazel.

`~/.kanna/.env.release.local` is kd's sole release-environment file for every
repository and worktree, and kd requires it to be owner-only (`0600`). A primary
checkout or worktree `.env.release.local` is never read; move any non-secret
release defaults needed by kd into the machine-global file, then remove the
obsolete repository file. Explicitly exported process values, including the two
notarization selectors and the three updater selectors, override values from
`~/.kanna`; use this only for deliberate
per-invocation non-secret overrides. Apple IDs, app-specific passwords, API
private keys, updater private key material or passwords, and other secrets must
never be stored in plaintext release config. The release path does not forward
direct Apple credential variables into Bazel.

## Cloud services

```sh
./kd cloud deploy --staging            # Firebase (functions, rules, …)
./kd cloud deploy --production
./kd cloud deploy --staging --relay    # + relay (Cloud Run)
```

Never run `firebase deploy` directly. If `kd cloud deploy` misbehaves, fix the
`kd` workflow and redeploy through it. Environments: `kanna-build`
(production), `kanna-staging` (staging), `kanna-local` (emulators);
relay endpoints `wss://relay.kanna.build` / `wss://relay-staging.kanna.build`.

## Mobile

### App Store builds

```sh
./kd mobile archive --production --build-number <n>
```

Runs Expo prebuild (CNG) with `KANNA_APP_ENV=prod`, archives the generated
workspace, and exports an IPA under `.build/mobile/ios-production/`. Bundle
ids: `build.kanna.app` (prod), `build.kanna.app.staging`, `build.kanna.app.dev`.
The default `CFBundleShortVersionString` comes from `apps/mobile/VERSION`.
`--version <version>` is an explicit one-build override; if the mobile file is
absent, the root desktop `VERSION` remains a compatibility fallback. Always
pass a monotonically increasing `--build-number`; it controls
`CFBundleVersion` independently.
Run the [mobile production QA gate](../testing/mobile-production-qa-gate.md)
before TestFlight external testing or App Store submission.

### Mobile OTA

Self-hosted OTA updates are served by the relay (`/ota/manifest`,
`/ota/assets`) from the environment's GCS bucket and code-signed with the
committed certificate `apps/mobile/certs/ota-codesign.pem` (key id
`kanna-mobile-ota-v1`; private key lives in Secret Manager, never in the repo).

`runtimeVersion` in `apps/mobile/src/mobileEnvironments.json` gates
compatibility: bump it for any native code/config/SDK/dependency change
(including the identity config plugin and the embedded OTA certificate);
JS-only changes keep the runtime and are OTA-deliverable.

Every OTA command requires an explicit `--staging` or `--production` flag;
the examples below use staging:

```sh
./kd mobile ota publish --staging                     # publish signed update
./kd mobile ota publish --staging --rollback-to <id>  # repoint the channel
./kd mobile ota status --staging                      # channel pointer
./kd mobile ota doctor --staging                      # read-only preflight
./kd mobile ota provision --staging                   # bucket + relay IAM
./kd mobile ota provision-secret --staging --key-path <pem>  # key → Secret Manager
```

**Approval policy:** staging publish/rollback is self-serve (including for
agents). Production publish/rollback requires explicit human approval per
operation; read-only production `status`/`doctor` does not.
