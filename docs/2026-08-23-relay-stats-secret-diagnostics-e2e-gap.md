# Relay stats-secret diagnostics E2E gap (2026-08-23)

`kd cloud deploy --relay` now distinguishes an absent or empty optional stats
secret from a VM Secret Manager permission denial and other HTTP failures.
This crosses the local deploy client, gcloud SSH, VM metadata, and the Secret
Manager REST API.

The repository cannot exercise those outcomes end to end without deploying to
a real relay VM and deliberately changing production-like secret IAM. A safe
E2E test needs an isolated GCP project and disposable VM identity where the
test can create secret versions, toggle `roles/secretmanager.secretAccessor`,
and inject an upstream failure without touching staging or production.

Meanwhile, `tools/kd/tests/cloud-deploy.test.ts` asserts the exact generated
VM-side script for the HTTP/body separation and all diagnostic branches, and
tests the client-side IAM preflight's warning and non-fatal inspection failure.
