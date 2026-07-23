# Release & Deployment

Kanna ships four things: the desktop app (DMG + self-updater manifest), the
mobile app (App Store builds + self-hosted OTA updates), the relay service, and
Firebase cloud services. Everything goes through `kd`.

## Versioning

The root `VERSION` file is the single source of truth for the packaged app
version. `./kd release ship --release` updates `VERSION`, `tauri.conf.json`,
and Rust package metadata, commits, tags `vX.Y.Z`, and publishes a GitHub
release. `VERSION` governs the packaged desktop app only — workspace
`package.json` versions play no part in it (app-related packages sit at
`0.0.0`; a few services version independently, e.g. `services/relay` at
`0.1.0`). The desktop app reads `VERSION` at compile time via `build.rs`.

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
bazel build --config=notarize -c opt //:release   # signed + notarized DMGs
```

Outputs land in `bazel-bin/release/`. Notarization needs `APPLE_ID` /
`APPLE_PASSWORD` / `APPLE_TEAM_ID` (or `APPLE_KEYCHAIN_PROFILE`) exported in
the invoking shell. The checked-in `.bazelrc` shares a disk/repository cache
across worktrees under `~/Library/Caches/kanna-bazel/` without sharing the
live output tree.

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
