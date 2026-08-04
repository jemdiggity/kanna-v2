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

### Physical-device retry (2026-08-05)

Jerome's iPhone 15 was attached and unlocked for the requested retry. Device
discovery initially exposed a name-normalization detail: Xcode reports
`Jerome’s iPhone 15` with a typographic apostrophe, so the ASCII
`Jerome's iPhone 15` selector did not match. With Xcode's exact visible name,
the current PR #998 task build completed the canonical staging dev-client
build, install, and launch:

```text
KANNA_IOS_PHYSICAL_DEVICE_NAME='Jerome’s iPhone 15' ./kd mobile run --device --staging
Launched Kanna mobile on Jerome’s iPhone 15.
Bundle ID: build.kanna.app.staging
Metro: http://192.168.10.101:8174
App: installed and launched.
OK metro-lan: Metro is reachable at http://192.168.10.101:8174/status.
OK app-installed: build.kanna.app.staging is installed on Jerome’s iPhone 15.
```

WebDriverAgent also cleared the previous blocker. After pointing the canonical
device-smoke workflow at the installed staging desktop server on port 48121,
the WDA session started and the smoke advanced to the existing safe-fixture
guard:

```text
KANNA_APP_ENV=staging KANNA_MOBILE_SERVER_PORT=48121 \
  KANNA_IOS_PHYSICAL_DEVICE_NAME='Jerome’s iPhone 15' \
  ./kd mobile device-smoke
KANNA_E2E_PTY_TASK_ID is required. Provide a known live PTY task whose terminal
snapshot contains KANNA_E2E_PTY_SENTINEL; opening an arbitrary task row does not
prove mobile PTY rendering.
```

No arbitrary task was substituted, because doing so could expose real terminal
contents and would not produce a labeled deterministic output or TUI state.

The phone then displayed a load error. The task-local Metro log established the
cause without collecting application or terminal contents:

```text
./kd dev log mobile
CommandError: Must specify --private-key-path argument to sign development
manifest for requested code signing key
```

This prevents the current staging dev-client from loading the task JavaScript;
it is not terminal CPU or crash evidence. A machine-local OTA signing key exists,
but the canonical `./kd mobile` development workflow has no path selector for
it. This retry did not copy the key, add it to the worktree, run Expo directly,
or widen PR #998 with credential/workflow changes.

The canonical self-contained alternative was attempted twice with:

```text
KANNA_IOS_PHYSICAL_DEVICE_NAME='Jerome’s iPhone 15' \
  ./kd mobile run --device --staging --install
```

Both attempts stopped before compilation with `xcodebuild` exit 65:

```text
Build Preparation
Couldn't create workspace arena folder
'.../.build/mobile/ios-device-staging': You can’t save the file
“ios-device-staging” because the volume “VHS” is out of space.
** BUILD FAILED **
```

The exact build-private target is a worktree symlink to
`/Volumes/VHS/kanna-builds/kanna-7/task-670d3457-6`. At the retry it reported
931 GiB used of 931 GiB, 32 MiB available, and 91% inode use. The source/Data
volume separately had 70 GiB free; bypassing `.build` would violate the
canonical build-private workflow. No unrelated build artifacts or user data
were deleted.

Consequently the controlled profiling matrix remains blocked before a valid
fixed-duration interval can begin. Idle terminal, output burst, and
alternate-screen TUI were all skipped over LAN and relay. Ordinary output was
also skipped over both transports, matching the original eight-state matrix.
No Instruments/Energy Log interval was recorded, so this retry yields no
after-side CPU percentage, energy value, thermal-pressure value, footprint, or
crash-rate evidence and makes no on-device performance or crash claim.

Disposition: **needs human input**. Free sufficient space on `/Volumes/VHS` so
the canonical self-contained staging install can build, or provide a canonical
`./kd mobile` mechanism that supplies the existing development-manifest signing
key without copying it into the worktree. A deterministic safe PTY fixture is
also required before output and alternate-screen states can run; until then,
only a content-free idle interval would be eligible after the app loads. Do not
publish OTA, staging, or production as part of that unblock.
