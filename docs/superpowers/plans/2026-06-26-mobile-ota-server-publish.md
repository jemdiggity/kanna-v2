# Mobile OTA Server Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the server-side Kanna mobile OTA implementation: relay manifest/assets, signed GCS-backed storage, kd publish/status/rollback tooling, deploy secret wiring, certificate docs, verification, and PR.

**Architecture:** Keep relay request routing thin in `services/relay/src/index.ts` and put OTA protocol behavior in `services/relay/src/ota.ts`. Keep publish/status/provisioning in `tools/kd/src/runtime/mobile-ota.ts`, using kd-managed `pnpm exec expo export` and `gcloud storage` commands so operators never call cloud tools directly. Preserve the shared contract from `docs/specs/mobile-ota-updates.md`.

**Tech Stack:** TypeScript, Node HTTP, `@google-cloud/storage`, Vitest, `pnpm`, Google Cloud Storage and Secret Manager through kd command plans.

---

### Task 1: Confirm Existing Scope And Contract

**Files:**
- Read: `services/relay/src/ota.ts`
- Read: `tools/kd/src/runtime/mobile-ota.ts`
- Read: `tools/kd/src/runtime/cloud-deploy.ts`
- Read: `docs/specs/mobile-ota-updates.md`
- Read: `CLAUDE.md`

- [x] **Step 1: Inspect relay and kd implementation**

Run: `rg --files services/relay tools/kd apps/mobile docs | rg 'ota|cloud-deploy|environment|mobileEnvironments|codesign|mobile-ota'`

Expected: Existing OTA server, tests, kd runtime, docs, cert, and deploy wiring are present.

- [x] **Step 2: Verify targeted OTA relay behavior**

Run: `pnpm --dir services/relay exec vitest run test/ota.integration.test.ts --reporter=verbose`

Expected: OTA integration tests pass in isolation.

- [x] **Step 3: Compare against Expo protocol references**

Check the official Expo Updates v1 request/response/code-signing requirements and the custom Expo updates server reference implementation. Confirm `expo-protocol-version: 1`, multipart `manifest` or `directive` parts, `expo-signature`, and immutable asset cache headers match Kanna's implementation.

### Task 2: Fix `updateId` Hash Source In Publish Tooling

**Files:**
- Modify: `tools/kd/src/runtime/mobile-ota.ts`
- Modify: `tools/kd/src/runtime/mobile-ota.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that runs the dry-run publish path with Expo metadata paths that need staging rewrite, then asserts the published `updateId` equals the SHA-256 UUID of the staged `metadata.json` bytes. This catches the contract gap where `updateId` was computed from raw Expo metadata before staging.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --reporter=verbose`

Expected: The new test fails because `executeMobileOtaPublishWithContext` reports an update id derived from pre-staged metadata.

- [ ] **Step 3: Implement the minimal fix**

Change `stageOtaUpdate` to return the rewritten `metadata.json` bytes and update id. Change `executeMobileOtaPublishWithContext` to stage first, then build the publish plan with that staged update id. Keep `buildMobileOtaPublishPlan` available for dry-run planning tests and align it with the staged metadata contract when `distDir` is provided.

- [ ] **Step 4: Run the kd OTA tests**

Run: `pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts --reporter=verbose`

Expected: All mobile OTA tests pass.

### Task 3: Tighten Relay/Kd Verification

**Files:**
- Modify if needed: `services/relay/src/ota.test.ts`
- Modify if needed: `services/relay/test/ota.integration.test.ts`
- Modify if needed: `tools/kd/src/runtime/cloud-deploy.test.ts`

- [ ] **Step 1: Run relay OTA unit and integration tests**

Run: `pnpm --dir services/relay exec vitest run src/ota.test.ts test/ota.integration.test.ts --reporter=verbose`

Expected: Manifest helper tests and OTA relay integration pass.

- [ ] **Step 2: Run kd OTA and relay deploy tests**

Run: `pnpm --dir tools/kd exec vitest run src/runtime/mobile-ota.test.ts src/runtime/cloud-deploy.test.ts tests/cloud-deploy.test.ts --reporter=verbose`

Expected: OTA publish/status/provisioning tests and deploy-secret wiring tests pass.

### Task 4: Typecheck And Docs

**Files:**
- Modify if needed: `docs/specs/mobile-ota-updates.md`
- Modify if needed: `CLAUDE.md`

- [ ] **Step 1: Typecheck relay and kd**

Run: `pnpm --dir services/relay build`

Run: `pnpm --dir tools/kd typecheck`

Expected: Both exit 0.

- [ ] **Step 2: Confirm docs include contract and operations**

Verify docs prominently state keyid `kanna-mobile-ota-v1`, public cert path `apps/mobile/certs/ota-codesign.pem`, private-key Secret Manager name `kanna-mobile-ota-private-key-pem`, GCS layout, publish/status/rollback commands, and the E2E gap.

### Task 5: PR

**Files:**
- Use git/GitHub CLI only after verification.

- [ ] **Step 1: Review final diff**

Run: `git status --short`

Run: `git diff --stat`

Run: `git diff -- services/relay tools/kd apps/mobile docs CLAUDE.md`

Expected: Diff is scoped to server/publish OTA deliverables and does not implement client expo-updates runtime wiring.

- [ ] **Step 2: Create PR**

Run: `git push -u origin task-0d7389cc`

Run: `gh pr create --title "Implement self-hosted mobile OTA server publishing" --body-file <generated-pr-body>`

Expected: PR body summarizes endpoints, GCS layout, private-key provisioning, keyid, publish/status/rollback commands, tests, and E2E gap.
