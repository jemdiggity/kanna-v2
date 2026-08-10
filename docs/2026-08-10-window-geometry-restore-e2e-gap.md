# Unavailable-display window restore E2E gap

2026-08-10. The desktop E2E suite now verifies that reloading the current
Tauri window reapplies geometry seeded in `window_workspace_v1`, and it already
verifies recreation of a saved secondary window at its persisted bounds.

## Why unavailable-display fallback is not covered end to end

The Tauri WebDriver surface can move and resize windows, but it cannot change
the monitor topology reported by macOS while the app is running. The restore
path reads `availableMonitors()` and `primaryMonitor()` directly from Tauri, so
an E2E run cannot make previously saved bounds refer to a disconnected display
without changing the host machine's real display configuration.

## What would make it testable

A test-only Tauri command or injectable monitor provider that overrides the
monitor work areas for one reload would let the suite seed bounds on a removed
display, reload the app, and assert that the native window appears inside the
remaining display's work area. A CI runner that can attach and detach a virtual
display before reloading would provide equivalent coverage.

## Narrower coverage meanwhile

`apps/desktop/src/windowWorkspace.test.ts` verifies that
`resolveRestorableWindowGeometry` moves a fully off-screen rectangle into the
primary work area and preserves geometry that still intersects an available
monitor. `apps/desktop/src/windowWorkspace.tauri.test.ts` verifies the Tauri
monitor lookup and native geometry application boundary with controlled API
doubles.
