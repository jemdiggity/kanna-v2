# `kd mobile publish` E2E Gap

`kd mobile publish` crosses a system boundary — kd → Xcode → altool → App Store
Connect — and by [AGENTS.md](../AGENTS.md) that obliges E2E coverage. It cannot
have it. This note records why, what would make it testable, and what narrower
tests were added instead.

## Why the live path cannot be E2E-tested

App Store Connect is an external Apple service with **no sandbox and no test
tenant**. Every attempt at the real path is a real attempt:

- **A build number is permanently consumed.** Apple refuses a repeated
  `CFBundleVersion` for a marketing version, forever. A test that uploads burns
  a number out of the same monotonic sequence the real release uses.
- **An upload cannot be withdrawn cheaply.** Removing an accepted build is a
  manual App Store Connect operation, and the number stays consumed.
- **Processing is Apple-side and slow.** The wait stage polls for minutes to
  tens of minutes with no way to force a state.
- **The archive stage is a full native Xcode build**, which is measured in
  double-digit minutes on a warm machine and needs a signing identity plus an
  App Store provisioning profile for team `EA4J68749Z` in the local keychain.
- **The verify stage reads a real signed IPA**, which only that build produces.

There is no read-only or reversible variant. Even the "harmless" first call —
resolving the app id — needs live credentials that are not, and should not be,
available to CI.

## What would make it testable

In rough order of how much each would buy:

1. **A fake App Store Connect server.** The REST client already takes an
   injected `AppStoreConnectHttpRunner`, so a local HTTP fixture server would
   let an E2E run exercise the real JWT signing, URL construction, pagination,
   and error handling end to end — everything except Apple's own behavior. This
   is the cheapest real improvement and does not need Apple at all.
2. **A committed signed IPA fixture.** A single real production IPA (or a
   scrubbed copy) checked in as a test fixture would let `kd mobile verify` run
   against genuine `codesign`, `security cms`, `plutil`, and `sips` output
   rather than stubs. It is not committed today because it is ~100 MB and
   carries a real signing certificate chain.
3. **A dedicated throwaway App Store Connect app record.** Apple allows extra
   app records under the same team; one reserved for tooling tests would make
   uploads consequence-free for the shipping app. It still consumes build
   numbers, still takes tens of minutes per run, and still cannot run in CI, so
   this is a manual-soak tool rather than an E2E test.
4. **A signing-capable CI runner.** Required before any of the above could run
   unattended.

## What was tested instead

All in `tools/kd/src/runtime/`, following the patterns in
`mobile-archive.test.ts` and `mobile-ota.test.ts`.

**`app-store-connect.test.ts`** — the REST client against a stubbed HTTP runner:

- ES256 JWT header and payload, the 64-byte JOSE (`ieee-p1363`) signature
  encoding Apple requires rather than Node's default DER, base64url with no
  padding, and the lifetime staying inside Apple's 20-minute cap.
- Credential resolution: both environment variables named when either is
  missing, and the `.p8` path named when the key file is absent.
- `findAppId` pinning the bundle id exactly, because Apple's `filter[bundleId]`
  is a prefix match that also returns `build.kanna.app.staging`.
- Apple's `errors[].title`/`detail` surfaced instead of a bare status code.
- Build listing and lookup, App Store version lookup, the attach `PATCH` body,
  and the release-type `PATCH` body.
- Numeric build-number comparison, so `10` beats `9`.

**`mobile-verify.test.ts`** — every check against on-disk `.app` fixtures with
the macOS tools stubbed. One passing case, then a distinct failing fixture for
each refusal: a development signing authority; a profile with
`ProvisionedDevices`; a profile for another app id; a missing profile;
version/build/bundle-id disagreement; an icon with alpha; a 512px icon; a
missing icon; staging JS; a native shell whose OTA channel disagrees with the
JS bundle's; a missing embedded `app.config`; an IPA built from a different
commit than the publish resolved; and an IPA that bakes in no commit when one
is expected. Plus IPA extraction refusals and sha256 hashing.

**`mobile-publish.test.ts`** — the orchestration with the archive, verify, and
App Store Connect layers injected:

- CLI parsing for `mobile publish` and `mobile verify`, including rejected flags.
- Every refusal path: missing `--production`, a missing or non-numeric build
  number, a non-release ref (and the `--allow-non-release-ref` override), a
  dirty worktree refused before any App Store Connect call, a build number at or
  below the highest already uploaded, an unknown `--release-type`, a failed
  archive, a failed verification, an IPA whose hash no longer matches the
  record, a build Apple marked `INVALID`, and a missing `appStoreVersion`.
- Plan composition and `--dry-run`: resolution and the build-number query happen,
  nothing else does, and the human-only steps are printed.
- The happy path: stage order, the exact App Store Connect call sequence, the
  full publish record contents, and the annotated tag carrying the record and
  being pushed.
- Reuse and resume: a failed upload leaves `archive`/`verify` banked; `auto` on
  a resume keeps the recorded number instead of consuming another; a recorded
  `upload`/`wait` is skipped; a different explicit build number starts a fresh
  record; an existing tag is not re-created but is still pushed.
- The wrong-source path: the resolved commit is passed to both the archive and
  the verify layers, and a verification that rejects the baked commit stops the
  run before it uploads or tags.

**`mobile-archive.test.ts`** covers the archive reuse semantics publish delegates
to, including the three cases that decide reuse on provenance rather than on
version and build number alone: a matching commit reuses, a different commit
rebuilds, and an archive with no baked commit rebuilds.

**`apps/mobile/src/mobileAppConfig.test.ts`** covers the config hardening publish
depends on: an unset or unrecognised `KANNA_APP_ENV` throws rather than
resolving to production, `production` is accepted as the alias kd itself emits,
and `KANNA_SOURCE_REF`/`KANNA_SOURCE_COMMIT` are baked into `extra.kanna.source`.
**`tools/kd/tests/dev-plan.test.ts`** asserts every Metro-starting window names
an environment, so the throw cannot fire on a kd-driven run.

## Manual verification performed

The config change was checked against the real Expo config loader rather than
only through unit tests, since `app.config.ts`'s default export is what Expo
calls:

- `KANNA_APP_ENV=prod pnpm exec expo config --type public --json` produces output
  byte-identical to the pre-change config.
- The same command with `KANNA_APP_ENV` unset exits non-zero with the new
  guidance message.

The upload, wait, and attach stages were **not** run against App Store Connect
during development, and no build number was consumed.
