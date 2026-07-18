# Staging Mobile OTA Infrastructure Design

## Goal

Provision and harden Kanna's staging mobile OTA infrastructure through reproducible `kd` workflows, without changing production or publishing an OTA while the Expo SDK 57 publisher task remains unresolved.

## Current Failure

The configured staging bucket, `kanna-staging.firebasestorage.app`, does not exist, so OTA status and pointer checks return 404. Secret Manager is disabled and the signing-key secret and relay access binding do not exist. The existing secret-provisioning command assumes Secret Manager is already enabled, while no canonical OTA command creates the bucket. The doctor also passes filter flags unsupported by the installed `gcloud storage buckets get-iam-policy` command, preventing it from accurately checking bucket IAM.

## Architecture

Add a dedicated, idempotent `./kd mobile ota provision --staging` workflow for non-secret OTA infrastructure. It will resolve the environment exclusively through the existing environment registry, enable the required Google APIs, create the configured bucket only when it is absent, resolve the existing relay VM service account, and grant that identity object-read access to the OTA bucket.

Keep private-key handling in `./kd mobile ota provision-secret --staging --key-path <path>`. Harden that workflow so it enables Secret Manager before describing or creating the secret, adds a new secret version from the supplied file without reading its contents into output, and grants the relay service account secret accessor rights.

Keep `./kd mobile ota doctor --staging` read-only. Replace server-side `gcloud` IAM filtering with a JSON policy read followed by local parsing so the check is compatible with the installed CLI and verifies the exact role/member pair. Doctor must continue to report that it performs no writes.

## Command Boundaries

- `mobile ota provision`: API enablement, bucket existence, and bucket IAM.
- `mobile ota provision-secret`: Secret Manager enablement, secret creation/versioning, and secret IAM.
- `cloud deploy --staging --relay`: build and deploy the staging relay with the configured bucket and mounted signing secret.
- `mobile ota doctor` and `mobile ota status`: read-only evidence after provisioning and deployment.

All cloud mutations target `kanna-staging` only. The implementation and operational run must reject ambiguous environment selection and must never invoke a production command.

## Execution Flow

1. Run focused automated tests for the new provisioning contract and doctor IAM parsing.
2. Commit the repository changes so the clean-worktree deployment guard is satisfied.
3. Run `./kd mobile ota provision --staging`.
4. Run `./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"` without printing the key.
5. Run `./kd cloud deploy --staging --relay` through the canonical cloud workflow.
6. Run `./kd mobile ota doctor --staging` and `./kd mobile ota status --staging` as final read-only evidence.

No `mobile ota publish` or rollback command will run. No physical iPhone install, launch, or Appium action will run.

## Error Handling and Idempotency

API enablement and IAM-binding commands are safe to repeat. Bucket creation first performs an explicit describe operation: an existing bucket is retained, a confirmed missing bucket is created with the repository-defined location and uniform bucket-level access, and an unexpected inspection error aborts instead of being mistaken for absence. Secret creation follows the same distinction between an existing resource, a confirmed not-found response, and other failures.

Every failed cloud command stops the workflow with its stderr or stdout. The command reports only resource names, project, bucket, service account, and key id; it never prints private-key bytes or secret payloads.

## Testing

Focused `kd` tests will cover:

- CLI parsing for `mobile ota provision`.
- Staging environment resolution and exact API, bucket, and IAM commands.
- Existing-bucket idempotency and missing-bucket creation.
- Aborting on non-not-found bucket and secret inspection failures.
- Secret Manager enablement before secret operations.
- Doctor IAM parsing from policy JSON and the absence of write commands.
- Explicit rejection of missing or conflicting environment flags.

The existing cloud-deploy tests will continue to verify staging relay environment wiring. Final verification will include the focused `kd` test suite, broader relevant checks, a clean git diff review, and fresh staging doctor/status output.

## Human-Only Blocker

End-to-end OTA apply verification remains human-only and additionally depends on the separate Expo SDK 57 publisher task. This task will leave the staging channel without a published update if none already exists; doctor/status may therefore identify the missing pointer or manifest update as the sole remaining blocker after infrastructure checks pass.
