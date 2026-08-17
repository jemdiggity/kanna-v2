# Mobile machine/repository task creation E2E gap

2026-08-17. Written alongside the mobile fix that limits task creation to
machines where the selected repository is registered and rejects stale
machine/repository combinations before sending a create request.

## Behavior covered

Mobile now builds one logical repository from the existing `remoteUrlHash`
identity and retains the desktop ids whose `/v1/repos` inventories contained
that repository. The new-task composer offers only those desktops. Both the
relay transport and the LAN-composite transport refresh the destination's repo
inventory before translating to its machine-local repo id; an absent member
raises a definite, user-visible `RepoNotRegisteredError` and no create request
is sent.

## Why full E2E coverage is not included

The mobile Appium harness currently owns one real `kanna-server` repository
inventory. Its synthetic cloud desktop fixture can publish task snapshots for
a second desktop, but it cannot serve an independently configurable
`GET /v1/repos` response and receive relay invocations for that second desktop.
Consequently it cannot reproduce the causal condition: one remote hash present
on MacBook Pro, absent on Mac Studio, with the app attempting creation on Mac
Studio. A single-server run would only retest ordinary repo creation.

## What would close the gap

Extend the relay/Appium harness to register two independently invokable desktop
connections, each backed by its own configurable repo inventory. The E2E should
then register the same remote on both machines under different local ids and
verify both remain selectable, remove it from one destination, verify that
machine disappears from the composer, and finally exercise a stale-picker race
to assert the inline `repo is not registered on machine` error and zero task
creation on either server.

## Narrower causal coverage added meanwhile

- `remoteTransport.test.ts` drives two per-desktop repo inventories, asserts
  the typed error names the repository and destination, and proves no foreign
  create request is sent.
- `cloudLanClient.test.ts` proves the same fail-closed behavior for the LAN
  route after a fresh destination inventory read.
- `repoIdentity.test.ts`, `CreateTaskComposer.test.tsx`, and
  `mobileController.test.ts` cover hash-based registration union, picker
  filtering, preserved store metadata, and the controller's stale-selection
  guard.
