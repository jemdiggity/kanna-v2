# Expo SDK 57 Mobile OTA Config Design

## Goal

Restore `./kd mobile ota publish --staging|--production` after Expo SDK 57 stopped emitting `expoConfig.json`, while preserving the public Expo config that the relay places in the update manifest's `extra.expoClient` field.

## Root Cause

The publisher assumes `expo export` writes `apps/mobile/dist/expoConfig.json` and copies that file into the staged update. Expo SDK 57's supported native export contains `metadata.json`, the Hermes bundle, and assets, but no `expoConfig.json`. The tests hide the mismatch by creating the obsolete file in their export fixtures.

## Architecture

Keep `expo export` as the supported source for bundle and asset metadata. After a successful export, invoke Expo CLI's public-config interface, `expo config --type public --json`, from `apps/mobile` with the same `KANNA_APP_ENV` used for the export. This command returns the processed, filtered app config that Expo embeds in builds and updates.

Capture the public config as command output rather than writing a synthetic file into `dist`. Validate that the command succeeds and returns valid JSON, then pass its exact JSON bytes into OTA staging. `stageOtaUpdate` will write those bytes as `expoConfig.json` alongside the rewritten `metadata.json`, content-addressed bundle, and assets because the relay's existing storage contract expects that filename.

The publisher remains the only orchestration entry point. No app config, relay protocol, cloud layout, or runtime compatibility boundary changes.

## Data Flow

1. `kd mobile ota publish` checks that the git worktree is clean.
2. The publisher runs `expo export --platform ios --output-dir <dist>` with the selected `KANNA_APP_ENV`.
3. The publisher runs `expo config --type public --json` with the same environment and validates its stdout as JSON.
4. Staging rewrites export metadata to content-addressed paths and writes the validated public config as staged `expoConfig.json`.
5. A dry run stops before all GCS probes and writes; a real publish keeps the existing immutable-update and channel-pointer behavior.

## Error Handling

If the public-config command exits unsuccessfully, surface its stderr or stdout through the existing command-failure convention. If it exits successfully but stdout is not valid JSON, fail before staging or cloud access with an explicit Expo public-config error. Do not fall back to reconstructing config from `app.config.ts`, `metadata.json`, or hard-coded fields.

## Testing

Update the OTA fixtures to match SDK 57 by omitting `dist/expoConfig.json`. Add a regression test that runs the publish workflow with a fake command runner, returns the processed public config from `expo config --type public --json`, and verifies that dry-run completes without any `gcloud` call. Assert that export and public-config resolution both run from `apps/mobile` with the staging environment.

Add focused error coverage for malformed public-config JSON if the production boundary is exposed as a helper; otherwise cover it through the publish workflow. Follow red-green TDD: first remove the obsolete fixture and observe the ENOENT regression, then implement the command-backed staging input and make the focused test pass.

Verification will run the focused `tools/kd` OTA test, the `tools/kd` typecheck, and the canonical `./kd mobile ota publish --staging --dry-run`. The canonical dry run must complete without cloud reads or writes. This is JS/tooling-only, so `apps/mobile/src/mobileEnvironments.json` runtime versions remain unchanged.
