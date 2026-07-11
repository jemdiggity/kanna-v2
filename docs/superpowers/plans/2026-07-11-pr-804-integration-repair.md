# PR #804 Integration Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve PR #804's current credential architecture while restoring relay-outage coverage and making the remote-E2E specification describe the implementation that already exists.

**Architecture:** Keep the PR's existing merge topology because `origin/main` is already an ancestor and a plain rebase incorrectly flattens its intentional merge commits. Repair the regression at the tip: restore the current-main offline-invoke assertion in the terminal-flow E2E and update the canonical remote-E2E spec to match the selected dev/staging suites and the `connectionMode: "both"` contract.

**Tech Stack:** TypeScript, Vitest, pnpm, Kanna `kd` remote-E2E harness, Markdown.

---

### Task 1: Restore deterministic relay-outage coverage

**Files:**
- Modify: `tests/remote-e2e/src/terminal-flow.e2e.test.ts`
- Test: `tests/remote-e2e/src/terminal-flow.e2e.test.ts`

- [ ] **Step 1: Run a source-level regression check and verify it fails**

Run:

```bash
node -e 'const s=require("node:fs").readFileSync("tests/remote-e2e/src/terminal-flow.e2e.test.ts","utf8"); if(s.includes("await sleep(1_000)")) throw new Error("fixed relay sleep still present"); if(!s.includes(")).rejects.toThrow(/relay|closed|offline|failed/i);")) throw new Error("offline invoke assertion missing");'
```

Expected: exit 1 with `fixed relay sleep still present` on the uncorrected PR head.

- [ ] **Step 2: Restore the existing current-main assertion**

Remove this import:

```ts
import { setTimeout as sleep } from "node:timers/promises";
```

Replace the fixed delay after `await harness.stopRelay()` with:

```ts
await expect(harness.client.invokeDesktop({
  desktopId: harness.desktopId,
  method: "GET",
  path: "/v1/status",
  body: null
})).rejects.toThrow(/relay|closed|offline|failed/i);
```

- [ ] **Step 3: Re-run the source-level regression check**

Run the Step 1 command again.

Expected: exit 0.

### Task 2: Align the canonical remote-E2E spec with landed behavior

**Files:**
- Modify: `docs/specs/remote-task-e2e.md`

- [ ] **Step 1: Run a spec-consistency check and verify it fails**

Run:

```bash
node -e 'const s=require("node:fs").readFileSync("docs/specs/remote-task-e2e.md","utf8"); const stale=["### Remaining (v2 scope)","currently an intentional throw","connectionMode: \"local\"","⬜ **Cloud credential provisioning**","⬜ **LAN transport loop**"]; const found=stale.filter((x)=>s.includes(x)); if(found.length) throw new Error(`stale spec markers: ${found.join(", ")}`);'
```

Expected: exit 1 listing the stale remaining-work, staging, flow-status, and LAN-mode markers.

- [ ] **Step 2: Update delivery status and flow contracts**

Use this status:

```markdown
Status: implemented (v2 — dev flows 1–11 and Layers A–E are landed; staging
headless smoke is implemented and credential-gated; physical-device checks
remain human-gated)
```

Rename `### Remaining (v2 scope)` to `### Landed (v2)` and describe:

```markdown
1. Flows 1–3 are covered by `cloud-pairing-auth-discovery.e2e.test.ts`.
2. Flows 4–6 are covered by `task-listing-actions.e2e.test.ts` with current stage-graph semantics.
3. Flow 11 and LAN/relay parity are covered by `lan-layer.e2e.test.ts`.
4. Staging headless smoke is implemented in `staging-smoke.e2e.test.ts` and skips cleanly without credentials.
5. Layer C and Layer D entry points are implemented; physical-device execution remains human-gated.
```

Mark flows 1–6 and 11 as `✅`, change the LAN discovery contract to `connectionMode: "both"`, mark Layers C–E as landed, describe the staging runner as implemented, and rename the work breakdown to `Delivered work breakdown`.

- [ ] **Step 3: Re-run the spec-consistency check**

Run the Step 1 command again.

Expected: exit 0.

### Task 3: Verify, commit, update the PR branch, and merge

**Files:**
- Test: `services/firebase-functions/src/index.ts`
- Test: `tests/remote-e2e/src/*.ts`
- Test: repository-wide configured test graph

- [ ] **Step 1: Run focused static/build checks**

```bash
pnpm --dir services/firebase-functions build
pnpm --dir tests/remote-e2e typecheck
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 2: Run behavioral remote E2E**

```bash
./kd test remote-e2e
```

Expected: all selected dev specs pass, including the relay resilience assertion.

- [ ] **Step 3: Run the configured repository gate**

```bash
pnpm test
```

Expected: all Turbo test tasks pass.

- [ ] **Step 4: Commit the repair**

```bash
git add docs/specs/remote-task-e2e.md docs/superpowers/plans/2026-07-11-pr-804-integration-repair.md tests/remote-e2e/src/terminal-flow.e2e.test.ts
git commit -m "test: repair remote e2e integration coverage"
```

- [ ] **Step 5: Push with an exact lease and merge through GitHub**

```bash
git push --force-with-lease=task-cec02e1c:70736fa02f2183fe245c7c8635aa2f91ca147ccf origin HEAD:task-cec02e1c
gh pr merge 804 --merge
```

Expected: the push updates only PR #804's head and GitHub records a merge commit into `main`.
