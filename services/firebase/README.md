# Firebase emulator seed

`emulator-seed/` is a Firebase emulator export, imported by `./kd dev up
--emulators` and `./kd emulators up` so a fresh worktree comes up with
something to look at. It holds:

- **`auth_export/`** — the two seeded sign-in identities, including the
  "Buffy the Bug Slayer" test account whose avatar lives in `assets/`.
- **`firestore_export/`** — the cloud task index documents, plus the billing
  fixtures from `services/firebase-functions/src/billing/fixtures.ts`: one
  account per entitlement state the reducer can produce (stripe active, grace
  and expired; app_store active; comp alone, comp over stripe, comp revoked;
  both billed sources active; a refunded source beside a live one; and two
  unentitled accounts). Every entitlement document there was written by
  `recomputeEntitlement` itself, so a fixture cannot drift from the rules that
  derive it.

`./kd emulators exec` deliberately does **not** import this seed — the test
suites seed and clear Firestore themselves, and importing would leave them
asserting against somebody else's data.

## Regenerating it

```sh
pnpm --filter @kanna/firebase-functions build
pnpm exec firebase emulators:exec \
  --project kanna-local --config .firebase-<port>.kanna.json \
  --only auth,firestore \
  --import services/firebase/emulator-seed \
  --export-on-exit services/firebase/emulator-seed \
  "node services/firebase-functions/scripts/seed-billing-fixtures.mjs"
```

`--config` names the port-mapped config `kd` writes for this worktree
(`.firebase-<firestore-port>.kanna.json`); start the emulators once with `./kd
dev up --emulators` if it is not there yet.

Two things to check afterwards, because the export **replaces the whole
directory**:

- `assets/` is not part of the export and is deleted by it. Restore it
  (`git checkout -- services/firebase/emulator-seed/assets`).
- The auth export is rewritten with fresh `passwordUpdatedAt` stamps even when
  no identity changed. Unless you meant to change an identity, revert it
  (`git checkout -- services/firebase/emulator-seed/auth_export`) so the diff
  carries only what you actually changed.
