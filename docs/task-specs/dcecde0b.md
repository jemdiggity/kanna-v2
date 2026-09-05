# Task dcecde0b: load-flake cleanup round 3

## Terms

Fix the review-run binding, concurrent mDNS exchange, and kd inventory writer
flakes using lifecycle invariants, readiness gates, and controlled interleavings.
Read and reuse rounds ddc71838 and 4a576ad8. Scope is Rust and tools/kd;
no ignored tests, whole-lane serialization, unrelated cleanup, or unjustified
timeout increases. Investigate product races and fix bounded ones with coverage;
report larger discoveries separately. No protocol/schema changes absent a real race.

## Completion and verification

Record a default-parallel `./kd test all` baseline with concurrent
`cargo build --workspace` in a private `.tmp/` build directory, then isolated
results for each target. Document each root cause and three consecutive loaded
full-gate passes. Run `cargo fmt --all`, TypeScript checks, and strict Clippy.
Rebase onto origin/main after task 4068f128 merges before PR creation; this
manual implementation stage does not publish or advance the task.

## Investigation

2026-09-05: Read both preceding specs. The review-binding fixture already cancels
its initial running review before seeding the replacement on this branch; the
mDNS regression lives in `crates/task-transfer/tests/runtime.rs` and already
generates unique peer ids. Further root-cause investigation is pending.

### Baseline and isolation (2026-09-05)

- Default-parallel `./kd test all`: **passed**, ending with both canonical
  success messages (baseline started at 6f801c69, before the Clippy merge).
  Original inventory target 10/10; review-binding passed within server 1,246/1,246;
  concurrent mDNS passed within runtime 137/137. No named flake reproduced.
- Concurrent load: `cargo build --workspace` with private target
  `.tmp/load-target` and build directory `.tmp/load-build`; after the first
  build completed, repeated cleaning of only kanna-server/kanna-task-transfer
  in that private target and rebuilding sustained compiler load through the
  remaining gate. No test parallelism was changed.
- Original compiled review-binding test in isolation: **1/1**, 0.64s.
  Original compiled concurrent mDNS test in isolation: **1/1**, 1.03s.
- Diagnostic review-binding version: **100/100** isolated repeated executions
  under continued build load, followed by a default-parallel server-binary run
  **1,246/1,246** (71.74s). The diagnostic preserves HTTP error bodies.

### Findings and changes in progress

1. **Inventory: confirmed product race.** B reads A's lock owner, A exits, C
   acquires the lock, then B observes A's death and renames/removes C's live
   lock. B and C both write from the same inventory snapshot, losing a resource.
   A controlled three-process interleaving reproduces this on the original
   writer in 0.49s: the contender writes before the held replacement releases.
   Writers now publish a unique generation marker, remove only the inspected
   marker, and use atomic nonrecursive rmdir (a successor's marker prevents
   removal). This fixes all three writers: kd, desktop launcher, and daemon.
   Legacy owner.json remains readable for older processes; new readers also
   recognize abandoned legacy locks. Already-running old binaries retain their
   old recovery algorithm until upgraded. Inventory JSON itself is unchanged.
   The controlled process regression and full inventory target pass (10/10).
2. **mDNS: external delivery dependence.** The earlier Clippy task recorded a
   15-second pairing timeout, not a name-collision assertion. The existing
   fixture already namespaces peer ids, and waits for an IPv4-shaped endpoint,
   but that does not freeze later multicast cache updates or prove reachability
   of that endpoint on a multi-NIC machine. No new product isolation defect was
   demonstrated. The concurrent regression now feeds deterministic Bonjour
   ServiceResolved records through the actual resolver/cache, advertises both
   runs to each cache in different orders, verifies identity-to-endpoint routing,
   then pairs and transfers concurrently over real loopback TCP. Only the
   outer 30-second hang guard uses time. The separate live Bonjour integration
   test remains unchanged. Discovery legitimately lists foreign peers; this
   regression's isolation contract is pairing/transfer with the intended partner.
3. **Review binding:** git history confirms 90e4579f (2026-09-05 06:06) already
   fixed the duplicate-running-review fixture in this exact test, not merely
   another test in the file. Pin the one-active-main-run invariant before HTTP
   requests, preserve that cancellation, and retain full error bodies for future
   failures. Neither the baseline nor the 100 loaded diagnostic repetitions nor
   the full server binary reproduced the earlier HTTP 500. The historical 500's
   exact error body was not captured, so attributing that status conclusively
   to timing or to the old fixture would go beyond the evidence.

Final loaded proof runs, strict checks, and pre-PR upstream rebase are pending.

### Focused verification

- The original eight-child inventory harness also passed in isolation, retaining
  8/8 resources. The replacement controlled interleaving failed the original
  implementation and passes the fixed implementation; final inventory target
  **10/10**, with a frozen lock clock so scheduling the release gates cannot
  consume the product's lock-wait budget.
- Final controlled mDNS regression **1/1**; its peer-name helper is shared with
  the retained real Bonjour integration test, so duplicate generated names still
  fail the regression. The injection seam exists only in cfg(test) builds.
- Daemon stale-owner/legacy-owner regression **1/1**. The combined gate also
  passed the desktop counterpart and existing production-spawn-to-kd-cleanup
  test. Both Rust regressions explicitly replace the observed generation before
  invoking recovery; no elapsed-time assumption controls the interleaving.
- `pnpm exec tsc --noEmit` from tools/kd passed. At the repository root it prints
  help because there is no root tsconfig, matching the preceding Clippy task.
- `cargo fmt --all` and `git diff --check` passed.
- Pre-rebase `cargo clippy --workspace --all-targets` passed with the existing
  warnings that PR #1297 removes; none identify the new code. Strict proof is
  pending that upstream merge. No dependency or lockfile changed.
