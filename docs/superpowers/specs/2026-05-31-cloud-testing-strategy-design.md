# Cloud Testing Strategy Design

## Goal

Make Kanna cloud functionality testable before it reaches production, while still
keeping a small production health check. The test setup must cover the real
boundaries that have caused uncertainty: Firebase Auth, Firestore rules,
Cloud Run Functions, relay routing, desktop endpoint configuration, and desktop
publish/read behavior.

## Context

Kanna currently has local Firebase emulator support and a real desktop E2E for
cloud task sync. The E2E already starts two isolated desktop instances and can
exercise Auth, Firestore, Functions, relay, snapshot publish, snapshot read,
workspace merge, and remote terminal routing.

The gap is operational fidelity. Emulator tests cannot prove that deployed
Cloud Run functions, production-like Firebase app config, staging rules, relay
deployment, and desktop endpoint selection work together. Production-only tests
are too late and cannot safely validate candidate cloud changes before release.

## Recommended Test Tiers

### Tier 1: Local Emulator

This remains the default development and CI gate.

It starts Firebase Auth, Firestore, Functions, and the relay locally, then runs
desktop E2E against two isolated desktop instances. It proves product behavior
without depending on external cloud availability.

Coverage:
- Desktop sign-in against the Auth emulator
- Local snapshot publish through the same desktop boundary used at runtime
- Firestore snapshot read and workspace merge
- Cloud task grouping under matching local repos
- Relay terminal observe, input, resize, and close behavior
- Firestore rules and Function contract tests

### Tier 2: Staging Cloud

This is the release gate for cloud behavior.

Create a separate Firebase/GCP project for staging, deploy candidate Functions,
Firestore rules, and relay there, then run the same cloud E2E against staging
endpoints.

Coverage:
- Real hosted Firebase Auth
- Real hosted Firestore and rules
- Deployed Cloud Run Function behavior
- Deployed relay behavior
- Desktop runtime config pointing at staging
- Two-desktop cloud sync and terminal routing against deployed services

This tier is where cloud behavior should fail before production.

### Tier 3: Production Smoke

This is an opt-in or post-release health check, not a release-development test.

It uses a dedicated production test user and creates a disposable snapshot with
a unique test prefix. It verifies the deployed production function accepts the
snapshot and that the same user can read it back from Firestore. It then closes
or deletes the snapshot through an administrative cleanup path.

Coverage:
- Production Firebase config is valid
- Production Auth token can call the deployed Function
- Production Function writes the expected document
- Production Firestore rules allow the signed-in user to read it

It should not test new behavior, destructive flows, or UI workflows.

## Commands

Add explicit commands rather than relying on ad hoc environment setup:

- `./kd cloud deploy --staging`
  Builds and deploys Functions, Firestore rules, and relay to the staging
  project.

- `./kd test cloud-emulator`
  Runs the hermetic emulator cloud E2E.

- `./kd test cloud-staging`
  Runs the real cloud E2E against staging endpoints.

- `./kd test cloud-prod-smoke`
  Runs the minimal production smoke check with a dedicated production test user.

The existing `./kd dev up --emulators` remains the local interactive workflow.

## Configuration

Desktop cloud endpoints should be selected by environment, not hardcoded inside
the application code path.

Required config surface:
- Firebase app config: API key, auth domain, project ID, app ID
- Firebase Auth emulator override for local tests
- Firestore emulator override for local tests
- Functions endpoint override
- Relay URL override

Suggested environment names:
- `KANNA_CLOUD_ENV=local|staging|production`
- `KANNA_FIREBASE_PROJECT_ID`
- `KANNA_FIREBASE_API_KEY`
- `KANNA_FIREBASE_AUTH_DOMAIN`
- `KANNA_FIREBASE_APP_ID`
- `KANNA_CLOUD_FUNCTIONS_ENDPOINT`
- `KANNA_RELAY_URL`

Existing emulator-specific port variables continue to work for local tests.

## Test Data Isolation

Staging and production tests must use dedicated users and deterministic test
prefixes.

Snapshot IDs should include:
- environment name
- test run ID
- timestamp
- short random suffix

Example:
`staging:e2e-cloud-sync:20260531T120000Z:abcd1234`

Production smoke data should be closed or deleted immediately. Staging tests can
also run a scheduled cleanup for stale documents older than a fixed threshold.

## Observability

Cloud tests should expose enough diagnostic state to answer whether a task came
from cloud or LAN.

Add a diagnostics shape available to E2E and optionally the app UI:

```ts
interface RemoteTaskDiagnostics {
  itemId: string;
  prompt: string;
  repoId: string;
  sources: Array<"cloud" | "lan">;
  selectedTerminalTransport: "cloud" | "lan" | "local" | "none";
  ownerDesktopId?: string;
  ownerLocalTaskId?: string;
  cloudUpdatedAt?: string;
  lanUpdatedAt?: string;
}
```

Tests should assert transport explicitly when behavior depends on cloud rather
than LAN.

## Error Handling

Cloud commands should distinguish:
- no endpoint configured
- signed out
- authentication failure
- Function rejection
- Firestore read failure
- relay unavailable
- task visible only through LAN fallback

The app may keep best-effort behavior for users, but tests need structured
diagnostics instead of only console warnings.

## CI and Release Workflow

Recommended gates:

1. Pull request CI:
   - unit tests
   - Firestore rules tests
   - Function contract tests
   - `cloud-emulator` E2E for cloud-touching changes

2. Release candidate:
   - deploy to staging
   - run `cloud-staging`
   - run app packaging checks

3. Post-release:
   - deploy production
   - run `cloud-prod-smoke`

## Non-Goals

- Do not use production as the primary test environment for candidate cloud
  changes.
- Do not require two physical Macs for routine cloud validation.
- Do not make LAN fallback count as proof of cloud sync.
- Do not add broad production data cleanup permissions to the desktop app.

## Open Implementation Notes

The existing cloud E2E should be adjusted so snapshot publishing goes through
the desktop runtime publish boundary. Test-only seeding can remain for setup
fixtures, but at least one assertion path must prove the desktop can publish to
the configured Function endpoint.

The production smoke can start as a non-UI Node or Rust harness using Firebase
Auth REST plus Firestore SDK or REST. Once the cloud contracts are stable, it can
be wrapped by `kd`.
