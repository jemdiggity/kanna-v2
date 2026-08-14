# Mobile native "About this build" version — device E2E note

Non-archive iOS builds (dev/staging via `./kd mobile run --device`,
`./kd dev up --mobile`, `./kd mobile up`) used to embed
`CFBundleShortVersionString` `0.0.0`: `apps/mobile/app.config.ts` only set the
Expo `version` when `KANNA_APP_VERSION` was present (production archives), so
Expo fell back to the private-workspace placeholder version `0.0.0` in
`apps/mobile/package.json`, and "About this build" reported `0.0.0 (1)`.

`app.config.ts` now resolves an explicit `KANNA_APP_VERSION` first, then the
mobile-owned `apps/mobile/VERSION`, and finally the root desktop `VERSION` as a
compatibility fallback. `tools/kd/src/runtime/mobile-archive.ts` uses the same
precedence for its explicit `--version` and checked-in defaults. An empty or
malformed mobile file fails loudly rather than invisibly coupling the build
back to the desktop version. Dev builds therefore have a deterministic
non-placeholder fallback without inheriting every desktop release bump.

Staging now follows the same independent contract. Physical staging builds do
not download `desktop-staging/latest-staging.json` or convert a desktop RC into
a mobile marketing version. They leave `KANNA_APP_VERSION` unset by default so
`app.config.ts` reads `apps/mobile/VERSION`; an explicit value remains an
intentional diagnostic/build override. The native runtime remains `2.1.4` in
every environment.

## Verification status

Automated coverage added:

- `apps/mobile/src/mobileAppConfig.test.ts` — explicit environment override,
  mobile VERSION, and root fallback precedence; walk-up file resolution; and
  loud path-specific failures for empty or malformed mobile versions.
- `tools/kd/src/runtime/mobile-archive.test.ts` — the same three-level archive
  precedence and path-specific empty/malformed mobile VERSION failures.
- `tools/kd/tests/tasks.test.ts` — staging dev-client and bundled Release paths
  preserve identity/environment settings, leave the default version unset for
  `app.config.ts`, preserve an explicit override, and perform no desktop RC
  lookup.
- `apps/mobile/e2e/specs/smoke/profile-connection.e2e.ts` — the About-this-build
  journey fails on a placeholder or malformed Native value and can assert an
  exact expected native version/build.

The previous physical-device result in this note validated the older
desktop-coupled behavior and is superseded. Current physical verification is
tracked in `docs/2026-08-14-staging-mobile-marketing-version-e2e-gap.md`.
