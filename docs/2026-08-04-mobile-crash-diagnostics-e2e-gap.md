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

## Terminal CPU incident profiling follow-up

The retained incident reports establish the before-side evidence for the
2026-08-04 process, without establishing one shared cause:

- PID 43418 consumed 90 seconds of CPU in 132 seconds (68% average versus the
  OS 50% threshold), 105.315 seconds total CPU, and 60.30 mWh in the sampled
  interval. ThermalPressure was advisory 20. Footprint grew from 76.61 MB to
  109.72 MB and peaked at 126.58 MB. The heaviest sampled stack was the React
  runtime JavaScript thread in Hermes interpreter/string work.
- The same PID later terminated at 22:33:50 JST with EXC_CRASH/SIGABRT.
  `lastExceptionBacktrace` reaches `RCTExceptionsManager` fatal exception
  reporting and the abort occurred on
  `com.meta.react.turbomodulemanager.queue`. The report contains no JavaScript
  exception message, so this is evidence of a fatal JavaScript exception, not
  evidence that the CPU event caused it.

The current branch was built, installed, and launched on Jerome's iPhone 15
through `./kd mobile run --device --staging`. The canonical device doctor then
confirmed the staging bundle and task-local Metro were reachable. Controlled
after-side profiling could not proceed: `./kd mobile device-smoke`, pointed at
the installed staging desktop server, made four WebDriverAgent launch attempts;
each `xcodebuild` exited with code 65 and each WDA `/status` request timed out
after 60 seconds. The WebDriver session retry window then expired.

Therefore there are no defensible after-side CPU percentages, energy values,
thermal readings, or crash counts for idle, ordinary output, burst output, or
alternate-screen TUI states over either LAN or relay. Those eight
transport/state combinations remain explicitly unverified. The successful
install and launch are not a load profile and must not be used as evidence that
the hot path is fixed on-device. Profiling should be retried when WDA can
launch, using the same current build, fixed-duration labeled scenarios, and
Instruments Time Profiler/Energy Log or equivalent device metrics. Terminal
contents, credentials, and user input must not be captured or retained with
those measurements.
