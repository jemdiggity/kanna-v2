# Mobile repo-command recovery E2E gap

2026-08-16. Written alongside the fix for the More screen remaining on
`Commands unavailable` after a repository command successfully creates a task.

## Covered behavior

The mobile controller and navigation integration tests reproduce the causal
sequence with the real session store and rendered More route:

- the command-created task is absent from the first collection refresh and
  appears in the next background refresh;
- **Try Again** refreshes both the pending task and command-catalog paths,
  including when the task remains temporarily absent;
- a failed catalog read keeps the selected repository selected and visible.

The full mobile unit/integration suite continues to exercise both LAN-style
polling and the live cloud collection application path that invoke the shared
pending-task reconciliation logic.

## Missing device-level proof

The Appium smoke fixtures do not expose a repository command that can create a
task while deliberately withholding that task from exactly the first mobile
collection response. Reproducing the race on a simulator therefore requires a
controllable desktop/server fixture rather than the current static E2E seed.

Device-level coverage becomes feasible when the mobile E2E harness can script
the desktop API so `POST /commands/{command_id}` succeeds, the first subsequent
task collection omits the returned id, and a later collection includes it. An
Appium spec can then launch the command, wait through one background refresh,
and assert that the More screen recovers without changing repository selection.
