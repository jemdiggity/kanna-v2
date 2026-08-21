# Cloud Functions public invoker reconciliation

After a successful `./kd cloud deploy --functions`, derive the exported v2 callable/HTTP functions from `services/firebase-functions/src/index.ts`, exclude any deliberately annotated private function, and verify each corresponding Cloud Run service grants `roles/run.invoker` to `allUsers`. Repair missing bindings with `gcloud`, and fail with the exact recovery command if inspection or repair cannot complete.

Add kd coverage for present bindings, missing-binding repair and loud repair failure, plus private-function exclusion. Document why live IAM mutation is not exercised in CI, the 2026-08-22 staging recovery already performed, and manual re-verification steps. Do not change function behavior or Firebase configuration.
