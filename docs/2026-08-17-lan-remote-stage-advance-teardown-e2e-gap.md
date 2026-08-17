# LAN remote stage advance teardown E2E gap (2026-08-17)

`apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts` retains a
quarantined case for advancing a reachable LAN-only task from its viewing
desktop with Command-S.

The viewer dispatches the shortcut and the owning server accepts it. The owner
finishes the current `in progress` run and creates the next `qa` run in the
forked workspace, but that run immediately fails with:

```text
failed to start stage run: daemon error: agent session already exists or is tearing down
```

The task therefore remains in `in progress`. This is a server/daemon stage
transition lifecycle defect: the transition must not respawn the durable task
session id until the old workspace session has fully left the daemon registry.
Adding retries or sleeps to the E2E would conceal that ownership bug.

Remove the quarantine when a LAN-requested stage advance waits on the same
authoritative daemon teardown boundary as a local advance and the retained test
can observe the owner task reach `qa`. Existing App unit coverage proves remote
Command-S dispatch and LAN client selection; the two active cases in the same
real E2E file continue to prove LAN terminal/input routing and viewer-local
remote-pin persistence. No narrower test can prove the missing
server-to-daemon teardown ordering, so no substitute test was added here.
