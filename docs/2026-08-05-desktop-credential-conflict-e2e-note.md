# Desktop credential release/claim E2E coverage note

2026-08-05. Written alongside the fix for a staging desktop that toasted
`Cloud sync failed: permission-denied` on every launch.

## What went wrong

`desktopCredentials/{desktopId}` binds one machine to one cloud account.
`firestore.rules` lets the owning account rewrite it, and lets anyone claim it
once the owner has set `revokedAt` — so `revokeDesktopCloudCredential()`, which
runs only at sign-out, is the single thing that ever hands a machine to the next
account.

On the staging desktop it ran and wrote nothing. The user signed out of one
account and into another; the credential document's `updateTime` shows it was
untouched across that switch, so the revoke neither wrote nor threw — it hit one
of three unlogged `return`s (signed out, no Firestore, or a `desktop_cloud_credential`
invoke that `.catch(() => null)` had swallowed). Sign-out reported success, the
machine stayed claimed by the previous account, and every association from the
new one was denied by the rules with no way back.

Three defects, all now fixed:

- Revocation could decline to run and report success. It now raises every reason
  it cannot write.
- Revocation failure was awaited but unhandled inside `signOut`, so a *thrown*
  revoke would have blocked sign-out entirely — locking the user in the session
  they were trying to leave. Sign-out now always completes locally and returns
  `DesktopSignOutResult.desktopCredentialError`, which Preferences shows.
- The resulting denial surfaced as a generic repeating `Cloud sync failed:
  permission-denied`. It is now `DesktopCloudCredentialConflictError` with an
  actionable message, shown once per signed-in user.

## Why no emulator E2E yet

The full loop — sign out of account A, sign in as B, B claims the machine — needs
two authenticated emulator users driving one running desktop, plus the ability to
make revocation fail on demand mid-run to reproduce the stranding. The existing
Firebase emulator harness (`apps/desktop/tests/e2e/real/`) signs in a single test
user and writes the credential document *as* that user after reading the app's own
credential, so it has no second-account fixture and no fault-injection seam for
the revoke; the real-cloud smokes are env-gated and out of the default run.

Making it testable needs two seams: a second emulator user in the harness, and a
way to fail `desktop_cloud_credential` for one sign-out. Both are harness changes,
not product changes.

## Coverage added instead

- `services/firebase-functions/test/firestore-rules.test.ts` already proves the
  rules half against the emulator: a non-owner cannot rewrite a live credential,
  and can claim it once revoked. That is the denial this work consumes.
- `apps/desktop/src/services/desktopCloudAssociation.test.ts` — revocation raises
  instead of silently skipping when the local credential is missing or blank; a
  `permission-denied` becomes a conflict error; other backend codes pass through.
- `apps/desktop/src/services/desktopAuthSdk.test.ts` — sign-out releases first,
  and still completes locally, reporting the reason, when the release is refused.
- `apps/desktop/src/components/__tests__/PreferencesPanel.account.test.ts` — the
  unreleased-desktop warning reaches the Account tab.
- `apps/desktop/src/App.test.ts` — the conflict reports its own actionable message
  once per signed-in user, not the repeating generic toast.
