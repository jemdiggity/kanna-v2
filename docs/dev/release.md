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
separate from desktop release candidates, the OTA `runtimeVersion`, and the iOS
build number. Staging physical-device builds do not query desktop release
status to choose it. `KANNA_APP_VERSION` is an intentional diagnostic/build
override only; it does not select mobile identity or environment settings.

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

### The release lifecycle

Every staging build is a release candidate, and `desktop-staging` is a single
pointer, so the channel has state beyond "which build is on it". `kd` enforces
that state; the full model, the rules, and the incident that motivated them are
in [`docs/specs/release-candidates.md`](../specs/release-candidates.md). In
short:

- A staging publish must be a **descendant** of (or a rebuild of) the candidate
  the channel already serves. Divergence, rollback, and unverifiable channel
  metadata are refused **before** anything is built — including under
  `--dry-run`.
- A `release/X.Y` RC must build that branch's **remote tip exactly**. Push
  backports to the branch first, then build from a checkout of the pushed tip.
- While an **unpromoted** `release/X.Y` candidate is soaking, main staging
  publishes are refused. Main resumes after promotion, or after an explicit
  reset.
- Only `--rollback-to` and `kd release reset-staging` may move the channel
  non-linearly.

```sh
./kd release status                                   # channel state and every promotion blocker
./kd release cut --minor                              # cut release/X.Y at origin/main
./kd release promote 1.2.4-staging.3                  # promote a soaked candidate
./kd release reset-staging --to main \
  --reason "<why>" --confirm-abandon 1.3.0-staging.2   # abandon a lineage (audited, never implicit)
```

`kd release status` deliberately does not print one "promotable" flag. It
reports the active candidate and its source branch and commit, its lineage
relationship to the previous candidate and whether that lineage is valid, its
publication time and soak age, whether a release-branch freeze is active, any
release-branch commits not retained on main, whether the candidate is
*mechanically* promotable (its commit still matches its promotion branch tip),
and the full list of blockers to production promotion. The promote command is
printed only when every gate passes.

Candidate identity is verified independently of branch topology: the selected
GitHub object must be the exact named prerelease, its notes and versioned
`latest-staging.json` must agree on the version, and the remote tag plus a fresh
fetch must both resolve to the full commit SHA recorded by the release. Status
reports any mismatch as a promotion blocker before a build starts.

**Soak gate.** Production promotion requires the candidate to have been
published for at least `productionSoakHours` from `release-policy.json` at the
repository root (default 24; `0` disables it), validated by
`release-policy.schema.json`. A missing file uses the default; a malformed file
or an unknown key is an error naming the file. Status, `--dry-run`, and the real
promotion run the same decision code. The only override is explicit and
reasoned, and it waives the soak window and nothing else:

```sh
./kd release promote 1.2.4-staging.3 --override-soak "Grace asked for the crash fix today"
```

**Abandoning a series.** `origin/main`'s `VERSION` only advances when a
production release commits it, so bump inference cannot express "skip the series
we are abandoning". Name the intended series instead, and record what it steps
over — the abandoned branch is kept, never deleted or reused, and no production
tag is invented to advance `VERSION`:

```sh
./kd release reset-staging --to release/0.2 \
  --reason "0.1 diverged from main" --confirm-abandon 0.1.0-staging.8
./kd release cut --version 0.2.0 \
  --abandon-series 0.1 --reason "0.1 diverged from main; it will never ship"
```

Each abandonment is recorded as an annotated `abandoned/release/X.Y` tag, after
which `ship` and `promote` refuse that series and `status` reports it.

Direct production ships (`./kd release ship --production --release`) are not
promotions: they build whatever the checkout points at and never touched the
staging channel, so no soak applies. They remain a human-authorized operation.

### Local release environment

Notarization uses credentials stored in an explicitly selected, file-based
macOS Keychain. Run the setup once per release machine:

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

Keep the unencrypted Tauri updater private key in a dedicated owner-only file
outside the repository. Record its absolute path and the matching public key in
the machine-global release file:

```dotenv
KANNA_UPDATER_PUBKEY="<public key>"
TAURI_PRIVATE_KEY_PATH="/Users/example/.kanna/updater-signing.key"
```

The private-key file must be a regular, non-symlinked file owned by the current
user, readable only by that user, and mode `0400` or `0600`:

```sh
chmod 600 /Users/example/.kanna/updater-signing.key
```

Back up the original private key somewhere durable and offline. Losing this key
makes existing installations impossible to update. Every dry-run, staging,
production, and promotion build opens and validates that exact file and proves
it matches `KANNA_UPDATER_PUBKEY` before changing version files or starting
Bazel. The private material is passed only through the Tauri signer child
environment, never through argv, logs, release config, or command results. kd
sets an empty signer password explicitly, so the configured updater key must be
unencrypted and cannot trigger an interactive release-time prompt.

`~/.kanna/.env.release.local` is kd's sole release-environment file for every
repository and worktree, and kd requires it to be owner-only (`0600`). A primary
checkout or worktree `.env.release.local` is never read; move any non-secret
release defaults needed by kd into the machine-global file, then remove the
obsolete repository file. Explicitly exported process values override values
from `~/.kanna`; use this only for deliberate per-invocation non-secret
overrides. Apple IDs, app-specific passwords, API private keys, updater private
key material or passwords, and other secrets must never be stored in plaintext
release config. `TAURI_PRIVATE_KEY_PATH` is a selector, not key material. The
release path does not forward direct Apple credential variables into Bazel.

## Cloud services

```sh
./kd cloud deploy --staging                              # Firebase (functions, rules, …)
./kd cloud deploy --production --ref release/0.2
./kd cloud deploy --staging --relay                      # + relay VM
```

Never run `firebase deploy` directly. If `kd cloud deploy` misbehaves, fix the
`kd` workflow and redeploy through it. Environments: `kanna-build`
(production), `kanna-staging` (staging), `kanna-local` (emulators);
relay endpoints `wss://relay.kanna.build` / `wss://relay-staging.kanna.build`.

**`--ref <branch|tag|sha>` names the source the deploy builds.** It is required
with `--production` and optional elsewhere; when omitted, kd resolves and reports
the current `HEAD` so the output still records what shipped. The deploy consumes
the *working tree* — Cloud Build uploads the directory, it does not check the ref
out — so kd refuses a dirty worktree and refuses a `--ref` that is not the
checked-out commit. Fetch and check the ref out first:

```sh
git fetch origin && git checkout release/0.2 && git pull --ff-only
./kd cloud deploy --production --relay --ref release/0.2
```

The resolved commit appears in the command result (`source`, and `relay.commit`
for a relay deploy) and is baked into the relay image, which reports it as
`commit` on `GET /health` — see [relay VM operations](../relay-vm-operations.md).

## Mobile

### App Store builds

```sh
./kd mobile archive --production --ref release/0.2 --build-number <n>
```

`--ref <branch|tag|sha>` is required: the archive is built from the working tree,
so kd refuses a dirty worktree or a ref that is not the checked-out commit, and
reports the resolved commit in the archive output. Runs Expo prebuild (CNG) with
`KANNA_APP_ENV=prod`, archives the generated
workspace, and exports an IPA under `.build/mobile/ios-production/`. Bundle
ids: `build.kanna.app` (prod), `build.kanna.app.staging`, `build.kanna.app.dev`.
The archive and export steps allow automatic provisioning updates, so Xcode can
mint or refresh the required App Store provisioning profile. An Apple ID for
team `EA4J68749Z` must be configured in Xcode → Settings → Accounts.
The default `CFBundleShortVersionString` comes from `apps/mobile/VERSION`.
`--version <version>` is an explicit one-build override; if the mobile file is
absent, the root desktop `VERSION` remains a compatibility fallback. Always
pass a monotonically increasing `--build-number`; it controls
`CFBundleVersion` independently.
The command only builds when it has to. If the export IPA already exists and the
archive on disk records exactly the requested version and build number, the
prebuild, archive, and export steps are skipped and only `--upload` runs; the
result says `Reused existing mobile production archive`. This is safe because
App Store Connect refuses a repeated build number for a version, so changed
source obliges a new build number, which misses the match and rebuilds. Pass
`--force-rebuild` to rebuild a matching archive anyway.

`--upload` delivers with `xcrun altool --upload-app`, which ships with Xcode.
The command checks the uploader resolves before building, so a broken toolchain
fails in seconds instead of after a full archive.

`xcrun iTMSTransporter -m upload -assetFile` is deliberately not used. It
authenticates, reports "Creating reservations for build", then fails with an
undiagnosable `Could not upload file`; altool accepted the identical IPA
seconds later (verified 2026-08-18 on Kanna Mobile 1.0.0 build 2). Apple is
moving Transporter toward `-assetFile` and away from altool's `-f` during 2026,
so revisit this if `-f` is withdrawn.

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
the examples below use staging except where the production gate is the point:

```sh
./kd mobile ota publish --staging                     # publish signed update
./kd mobile ota publish --production --ref release/0.2  # production needs a named source
./kd mobile ota publish --staging --rollback-to <id>  # repoint the channel
./kd mobile ota status --staging                      # channel pointer
./kd mobile ota doctor --staging                      # read-only preflight
./kd mobile ota provision --staging                   # bucket + relay IAM
./kd mobile ota provision-secret --staging --key-path <pem>  # key → Secret Manager
```

A publish exports the working tree, so — as with `kd cloud deploy` and `kd
mobile archive` — it refuses a dirty worktree, requires `--ref
<branch|tag|sha>` for `--production`, and refuses a `--ref` that is not the
checked-out commit. Without `--ref`, staging resolves and reports `HEAD`. The
resolved commit is printed, returned as `source`, and recorded in both the
channel pointer and the update's own `kanna-source.json`, so a live OTA update
traces back to the commit it shipped from. `--rollback-to` exports nothing and
so needs no `--ref`; it still refuses a dirty worktree.

**Approval policy:** staging publish/rollback is self-serve (including for
agents). Production publish/rollback requires explicit human approval per
operation; read-only production `status`/`doctor` does not. `--ref` narrows
what a publish can ship — it does not replace that approval.
