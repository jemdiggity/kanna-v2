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

`release ship` refuses a dirty git worktree, and `--release` requires both
architectures to be built.

**Staging channel:** `./kd release ship --staging --release` builds
`X.Y.Z-staging.N` without persisting a version bump, publishes an immutable
prerelease tagged `vX.Y.Z-staging.N`, and repoints only `latest-staging.json`
on the `desktop-staging` pointer release. Roll back by repointing:
`./kd release ship --staging --rollback-to <version>`.

How the version is derived depends on the channel and the source branch
(`--branch main|release/X.Y`, defaulting to the current branch when it is a
`release/X.Y`, else `main`):

- **Series continuation (the default).** A bare staging ship — no explicit
  bump flag — whose source branch matches an **unpromoted** active candidate
  continues that candidate's series: `X.Y.Z-staging.N` becomes the next unused
  `X.Y.Z-staging.*`, with `N + 1` as its floor. It does not re-derive the
  series from trunk's `VERSION`.
- **main, new derivation**: an explicit `--patch` / `--minor` / `--major`
  (or a bare ship with no matching active candidate) applies the bump to the
  greater of the root `VERSION` and the greatest published production version
  — the *version floor*, reported as `versionFloor` on the ship result when it
  raised a stale trunk `VERSION`.
- **release/X.Y**: the base is the next patch after the series' existing tags;
  the bump flags are ignored. The branch must exist on origin, must not be an
  abandoned series, and its remote tip must be the checked-out commit.

Either way `N` is one past the highest existing `v<base>-staging.N` tag (and
past the active channel's `N`), and each staging publish prunes the channel
down to the five newest staging prereleases and their assets.

**Forward-version gate.** Whatever derived it, the candidate version must be
**strictly greater** than the version `desktop-staging` currently serves, by
semantic-version ordering including prerelease identifiers — commit ancestry
can never authorize a version rollback, and an explicit bump flag cannot roll
the channel back either. The refusal is actionable (it names the served
version and the two ways forward) and exits nonzero.

### The release lifecycle

Every staging build is a release candidate, and `desktop-staging` is a single
pointer, so the channel has state beyond "which build is on it". `kd` enforces
that state; the full model, the rules, and the incident that motivated them are
in [`docs/specs/release-candidates.md`](../specs/release-candidates.md). In
short:

- A staging publish must be a **descendant** of (or a rebuild of) the candidate
  the channel already serves, and must carry a strictly greater semver.
  Divergence, rollback (by commit or by version), and unverifiable channel
  metadata are refused **before** anything is built — including under
  `--dry-run`.
- A `release/X.Y` RC must build that branch's **remote tip exactly**. Push
  backports to the branch first, then build from a checkout of the pushed tip.
- While an **unpromoted** `release/X.Y` candidate is soaking, main staging
  publishes are refused. Main resumes after promotion, or after an explicit
  reset.
- Three paths may move the channel non-linearly: `--rollback-to`,
  `kd release reset-staging`, and — automatically, with no operator action —
  the post-promotion trunk resumption: once a `release/X.Y` candidate has been
  promoted (its production tag exists), the next main publish is allowed to
  diverge from it, and the publish writes a `Post-Promotion-Trunk-Resumption:`
  audit block onto the `desktop-staging` release body.

```sh
./kd release status                                   # channel state and every promotion blocker
./kd release cut --minor                              # cut release/X.Y at origin/main
                                                      # (--version must be strictly ahead of origin/main's VERSION)
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
repository root (default 24; `0` disables it). `kd` validates the file with its
own parser; `release-policy.schema.json` is editor-facing completion, not the
enforcement. A missing file uses the default; a malformed file
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
./kd cloud deploy --staging                              # Firestore rules + indexes + account portal
./kd cloud deploy --staging --functions                  # services/firebase-functions only
./kd cloud deploy --staging --portal                     # account portal only
./kd cloud deploy --production --ref release/0.2
./kd cloud deploy --staging --relay                      # relay VM only
```

Target flags select only the named targets and can be combined. With no target
flag, kd deploys the ordinary Firebase surface: Firestore rules and indexes plus
the account portal. The portal path idempotently ensures its configured Hosting
site exists before building and deploying it. Relay- and functions-only deploys
do not read portal build credentials.

**`--functions` is opt-in on purpose.** `services/firebase-functions` exported
nothing at all for most of its life, precisely so a stray `firebase deploy`
could not resurrect a retired endpoint, and it now carries the billing backend
that writes entitlements (`docs/specs/accounts-and-billing.md`). Without the
flag a deploy never builds or ships a function; with it, kd builds the package
and deploys the `functions` target. The scope kd used is reported back as
`targets`.

**The Secret Manager entries must exist before `--functions` can deploy.** Each
function declares the credentials it needs (`src/index.ts`, lists in
`src/billing/config.ts`), and `firebase deploy` refuses to deploy a function
whose declared secret is absent from the target project, naming it. So until
someone creates them, `./kd cloud deploy --staging --functions` fails — which is
the intended failure: it is better than publishing a billing backend whose
environment is empty, which would answer every Stripe delivery with a 500 until
Stripe disabled the endpoint. Create these secrets per project
(`kanna-staging` ↔ Stripe test mode, `kanna-build` ↔ live mode):

| Secret | Bound to | What it holds |
|---|---|---|
| `STRIPE_SECRET_KEY` | `createCheckoutSession` | Stripe API key for that mode |
| `STRIPE_WEBHOOK_SECRET` | `stripeWebhook` | Signing secret of that project's endpoint |

```sh
printf '%s' "$VALUE" | gcloud secrets create STRIPE_SECRET_KEY \
  --project kanna-staging --data-file=-
```

Bindings are per function, so each carries only what it uses: the webhook never
sees the API key and checkout never sees the signing secret.
`KANNA_PORTAL_BASE_URL` is public parameterized configuration, committed as the
production/local default in `services/firebase-functions/.env` and overridden
for staging in `.env.kanna-staging`; operators do not set it with
`functions:secrets:set`. `STRIPE_GRACE_FALLBACK_DAYS` is deliberately unbound:
it is optional with a documented default.

**Price ids are not configuration at all.** The catalog lives in Stripe
itself: the idempotent provisioning script

```sh
STRIPE_SECRET_KEY=... pnpm --filter @kanna/firebase-functions stripe:provision
```

creates (or finds) one "Kanna Cloud" product per mode plus one recurring,
multi-currency monthly Price under the stable lookup key `cloud_monthly`
(`--dry-run` prints the plan without contacting Stripe). USD is the default;
JPY/CAD/AUD/EUR/GBP are manual currency options at the price card amounts.
Checkout selects the buyer's local supported currency itself. The script
deactivates the retired `cloud_monthly_<currency>` Prices after the replacement
is available; it retains them in Stripe for existing subscription history.
`createCheckoutSession` accepts the monthly plan only and resolves this single
active Price at session time, so no price id is stored in Secret Manager or the
repo.

The Stripe account exists; remaining key and endpoint setup is tracked in the
Slice-0 runbook (`docs/specs/accounts-and-billing.md`).

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

To see what a deployed relay is actually doing — live connections, bytes by
class, tunnel buffer pressure, refused upgrades — use `./kd relay stats
--staging|--production`, `--open` for the live dashboard, or `--dry-run` to
print the resolved URLs and token source without touching Secret Manager.
Treat the `--open` output as a credential: the printed URL carries the
operator token in its query string. It reads the
operator token from Secret Manager, so no `gcloud compute ssh` is involved;
provisioning that token is in the same runbook.

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
The command only builds when it has to, and reuse is keyed on the **commit**,
not on the version and build number alone. The prebuild, archive, and export
steps are skipped — leaving only `--upload` to run, with the result reading
`Reused existing mobile production archive` — when all of the following hold:

- the export IPA exists;
- the archive on disk records exactly the requested version and build number; and
- the commit baked into the archived app (`extra.kanna.source.commit`, written
  at prebuild) equals the commit `--ref` resolved to.

Any mismatch rebuilds, and so does an archive that bakes in no commit at all —
which means **every archive produced before this rule existed rebuilds once**.
The result's `reuseReason` says which of the three gates decided it.

The commit gate is what makes reuse safe. Version and build number do not
identify a source: an attempt that archives and then stops before Apple accepts
the binary — a failed verification, a failed upload, a Ctrl-C — leaves an
archive on disk under a build number that is still free, so a rerun at a
different commit with that same number would otherwise reuse it and ship the
earlier commit's code.

`--force-rebuild` skips the reuse check entirely and rebuilds unconditionally,
even when all three gates pass.

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

### App Store publish

```sh
./kd mobile publish --production --ref release/0.2 --build-number 4 --dry-run
./kd mobile publish --production --ref release/0.2 --build-number 4
```

`kd mobile publish` is the whole shipping operation, staged and resumable:

| stage | what it does |
|---|---|
| resolve | Resolves `--ref` the same way `kd mobile archive` does, **and requires a `release/X.Y` branch.** |
| build-number | Asks App Store Connect for the highest `CFBundleVersion` already used for this marketing version, and refuses anything at or below it. |
| archive | Runs `kd mobile archive` (including its reuse semantics) without uploading. |
| verify | Runs every pre-upload check and hard-fails before the upload. Records the IPA sha256. |
| upload | `xcrun altool --upload-app`. Records the delivery UUID when altool reports one. |
| wait | Polls App Store Connect until the build's `processingState` is `VALID`, or a bounded timeout elapses. |
| attach | Attaches the processed build to the `appStoreVersion` for this marketing version. |
| tag | Writes the publish record and pushes an annotated `mobile-v<version>-<build>` tag at the resolved commit. |

**The release-branch requirement encodes a real incident.** The first Kanna
Mobile 1.0.0 submission was built from `main`, carried an unreleased feature,
and had to be withdrawn. `--allow-non-release-ref` bypasses it deliberately.

**Auto build numbers are opt-in.** `--build-number auto` takes the next number
after the highest already uploaded; the default is an explicit number, because
a build number is irreversibly consumed the moment Apple accepts the binary.

**Three things stay human and are only printed, never performed.** Export
compliance is a legal attestation. The release type is a judgement call, set
only when you pass `--release-type MANUAL|AFTER_APPROVAL|SCHEDULED`; unset means
untouched. Submit-for-review is an irreversible external action.

**Resuming.** Every stage writes `.build/mobile/ios-production/publish-<version>.json`,
so a rerun with the same ref skips what already succeeded — most importantly the
upload and the processing wait. `--build-number auto` on a resume keeps the
number the record already chose rather than consuming another. Verification is
re-run every time (it is the guard, not the work), and the run refuses to
continue if the IPA on disk no longer hashes to the value the record signed off
on. If App Store Connect has no App Store version for the marketing version
yet, publish stops after `wait` with instructions; create it and rerun.

**Reuse is keyed on the commit, not just the version and build number.** An
attempt that archives and then stops before Apple consumes the number — a failed
verification, a failed upload, a Ctrl-C — leaves an archive on disk under a
number that is still free. A rerun at a different commit with that same number
must not ship it. Two things prevent that: `kd mobile archive` compares the
commit baked into the archived app against the resolved ref and rebuilds on a
mismatch, and the verify stage hard-fails if the IPA's baked commit is not the
one this publish resolved.

**Provenance has two channels**, because an IPA in Apple's hands cannot be
queried the way the relay's `/health` can. The resolved ref and commit are baked
into `expoConfig.extra.kanna.source` at prebuild (JS config, so no
`runtimeVersion` bump), and the same facts plus the IPA sha256, delivery UUID,
and App Store Connect build id go into the publish record and into the annotated
git tag, which is the durable ledger.

Credentials are the same two variables `kd mobile archive --upload` uses —
`APP_STORE_CONNECT_API_KEY_ID` and `APP_STORE_CONNECT_API_ISSUER_ID` — plus
`~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`, which kd reads to sign
the ES256 JWT the App Store Connect REST API expects. There is no fastlane and
no Ruby toolchain: the durable Apple interface is that REST API, and a Ruby
dependency would break the repo's vendored-dependency rule while duplicating
identity config kd already owns.

### Verifying an IPA on its own

```sh
./kd mobile verify --ipa .build/mobile/ios-production/export/Kanna.ipa --build-number 4
```

The same five checks publish runs, each of which was hand-run three times during
the 1.0.0 release and two of which caught real defects:

1. the `codesign` leaf authority is an `Apple Distribution` certificate;
2. `embedded.mobileprovision` has no `ProvisionedDevices` and matches the app id;
3. the IPA's `CFBundleIdentifier`, `CFBundleShortVersionString`, and
   `CFBundleVersion` agree with the plan;
4. the 1024 marketing icon is 1024x1024 with no alpha channel;
5. the embedded Expo config declares `appEnv: prod` and OTA channel
   `production`, and the native `Info.plist` OTA channel agrees with it.

It also prints the IPA sha256. `--build-number` is optional; when omitted, the
build number is reported but not asserted.

Relatedly, `apps/mobile/app.config.ts` now **throws** on an unset or
unrecognised `KANNA_APP_ENV` rather than mapping it to production. Doing the
latter once produced a staging native shell wrapping production JS, whose only
symptom was an authentication failure indistinguishable from a wrong password.

Naming an environment explicitly is always honoured — only guessing is refused.
`dev`, `staging`, and `prod` are the canonical values, and `production` is
accepted as an alias for `prod` because that is what kd itself emits
(`productionMobileEnv` in `tools/kd/src/runtime/dev-plan.ts`, matching the alias
`resolveMobileAppEnv` in `tools/kd/src/runtime/mobile-device.ts` already
carried). Every kd path that starts Metro or prebuilds sets the variable, so in
practice the throw reaches a build that bypassed kd.

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
