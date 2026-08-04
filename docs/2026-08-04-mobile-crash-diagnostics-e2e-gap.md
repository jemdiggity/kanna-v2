# Mobile crash diagnostics E2E gap (2026-08-04)

## What was investigated

The intermittent mobile crash report did not leave a concrete failure signature
in the evidence available to this worktree:

- `~/Library/Logs/DiagnosticReports` contains no Kanna mobile report.
- Xcode's synced `~/Library/Logs/CrashReporter/MobileDevice` and device-log
  archives contain no Kanna mobile report.
- Both paired physical iPhones are currently unavailable to `xcrun devicectl`.
- At initial evidence collection the worktree had no running `kd` mobile
  session, so `./kd dev log mobile` reported that its task-specific tmux
  socket did not exist.

Code tracing covered app foreground/background refresh and OTA handling,
navigation mount/unmount cleanup, terminal subscription generation guards,
bounded scrollback compaction and WebView mutation, plus LAN/relay routing and
KSP reconnect behavior. No reproducible race or failure signature justified a
behavioral crash fix.

## Why a real-boundary crash assertion is not included

The current Appium lanes can background/foreground the app, switch LAN/relay
availability, navigate task detail, and inspect terminal output. They cannot
deterministically terminate the iOS WKWebView content process, crash the Android
render process, or inject a production-style fatal React render error. Adding a
shipping E2E-only crash trigger would widen the product surface and would still
not reproduce Jeremy's unknown incident.

A real-boundary regression becomes practical when either:

1. a device crash report identifies a reproducible native or JS failure path;
2. the mobile E2E harness gains a launch-only fault-injection channel that is
   unavailable in production and can terminate the WebView or throw below the
   root boundary; or
3. a paired physical device is available so the incident can be reproduced
   while `./kd mobile run --device` and device log streaming are active.

## Narrower executable coverage added meanwhile

- The diagnostic recorder test proves bounded persistence, lifecycle/transport/
  terminal metadata, corrupt-storage recovery, and that terminal content is not
  captured.
- The root error-boundary test proves React render failures produce a durable
  diagnostic reference and a recoverable fallback.
- The terminal WebView test invokes the real React Native WebView callback
  boundary for load errors, iOS content-process termination, and Android render-
  process loss, including scrollback size/offset and bridge readiness metadata.
- The build-info panel test proves retained diagnostics can be copied and
  cleared by the operator after relaunch.

The canonical mobile environment was subsequently started with
`./kd dev up --mobile --emulators`. Its E2E preflight passed against the
task-local server and iPhone simulator. The smoke runner also launched Kanna
and completed its trust deep link, then stopped before the terminal assertion
because the required live fixture was not supplied:
`KANNA_E2E_PTY_TASK_ID is required`. A known live PTY task whose snapshot
contains `KANNA_E2E_PTY_SENTINEL` is therefore the exact remaining blocker for
that existing real-boundary smoke flow. Even with that fixture, the current
runner has no fault-injection boundary for the crash classes above.

This change is diagnostic coverage, not a claimed fix for the reported crash.
The next incident should yield a copyable signature under **More → About this
build → Crash diagnostics**, while native process crashes and iOS jetsam still
require an Apple `.ips` report.
