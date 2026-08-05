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

### Physical-device retry after storage cleanup (2026-08-05)

The retry began with 205 GiB available on `/Volumes/VHS`; after Jeremy's
cleanup completed, the volume reported 618 GiB available. The exact requested
self-contained workflow then built, installed, and launched successfully:

```text
KANNA_IOS_PHYSICAL_DEVICE_NAME='Jerome’s iPhone 15' \
  ./kd mobile run --device --staging --install
```

This installed the current Release JavaScript bundle as
`build.kanna.app.staging` on the connected iPhone16,1 running iOS 26.5.2. The
build used the canonical private output at
`.build/mobile/ios-device-staging`, whose target is under `/Volumes/VHS`; it
did not depend on Metro. The matching generated app and dSYM remain in that
build output. Nothing was published.

One fixed-duration Power Profiler recording is valid. It attached to
KannaStaging PID 47565 on the physical phone for a configured 60 seconds. The
trace envelope ran from `2026-08-05T06:58:36.215+09:00` through
`2026-08-05T06:59:37.876+09:00` (61.660580 seconds including instrument
startup/teardown). The process accumulated 703,361,712 ns of
`ProcessQOSExecution` duration-on-core: 0.703361712 CPU-seconds, or 1.17226952%
average CPU over the fixed 60-second interval. Device thermal state was
`Nominal` for the full 61.660579919-second envelope and the Core Location
energy level was `None`. Power Profiler reported `0.0%/hr`, but the phone was
USB-attached with its display at 100% brightness, so that value is recorded
only as instrument output and is not a defensible battery-energy comparison.
The instrument did not expose an interval mWh figure. An earlier 1.918-second
trace used the wrong device selector and is invalid.

The measured interval was **Tasks-root idle**, not idle terminal: a later
content-free accessibility query found the app shell and Tasks view, with no
task detail or crash boundary. It therefore cannot establish terminal-path
performance. It is nevertheless a direct current-build comparison point
against the stale incident process's 68% average CPU and advisory thermal
pressure: this non-terminal idle state stayed at 1.17% average CPU and nominal
thermal state. It does not prove that the incident's terminal hot path is fixed.

A deterministic fixture was then started through the repository's remote-E2E
harness. It used a temporary repository, fake agent, synthetic sentinel-only
prompt, and 10,050 generated output lines; no real terminal contents,
credentials, or user input were used or retained. The canonical physical
device smoke workflow started WebDriverAgent but timed out waiting for the
known fixture task row. Direct observation showed no established phone TCP
connection to the LAN fixture port, and a repository test deep link did not
move the app from Tasks into task detail. The harness also repeatedly reported
that the protected-input successor daemon was not published and connectable.
Those are boundary failures before terminal rendering, not crash or CPU
measurements. A synthetic alternate-screen fixture exited during setup before
the phone could reach it, so it supplies no TUI result.

The staging relay matrix could not be started safely: the staging remote
harness requires `KANNA_E2E_DEVICE_TOKEN` and `KANNA_STAGING_TEST_PASSWORD`,
which were not present. No credentials were retrieved or copied. The installed
staging Release bundle also cannot be redirected to the local development
relay without rebuilding for a different app environment, so the local relay
was not represented as staging evidence.

| Transport | Terminal idle | Ordinary output | Output burst | Alternate-screen TUI |
|---|---|---|---|---|
| LAN | Skipped: fixture row unreachable from phone | Skipped: boundary not established | Skipped: boundary not established | Skipped: fixture setup and boundary failed |
| Relay | Skipped: staging credentials unavailable | Skipped: staging credentials unavailable | Skipped: staging credentials unavailable | Skipped: staging credentials unavailable |

The app process remained healthy during the content-free diagnostics checks.
The current build's More/build-information view reported no retained fatal
diagnostic, and no new device `.ips` report was found. Appium later terminated
the app intentionally through its configured session cleanup; that lifecycle
event is not a crash. Thus the 2026-08-04 CPU incident and later fatal JS
exception remain correlated observations from the same stale process, not
evidence of one root cause. This retry neither recovered the stale build's
missing JS exception message nor reproduced a current fatal exception.

No measurement proved a new defect in the reviewed output-cursor/lifecycle
fix, so its code was left unchanged. A complete on-device terminal comparison
still requires a phone-reachable safe LAN fixture and authorized staging relay
credentials, followed by separately labeled fixed-duration runs for every row
above.

### Human-driven real-usage profile (2026-08-05)

Jeremy reported that he was actively using the installed current task build on
the connected phone. Two read-only Instruments recordings attached to the
already-running KannaStaging PID 47710 without launching, foregrounding, or
controlling the app. No accessibility hierarchy, screen capture, sampled
memory, terminal text, credentials, or input was inspected or exported. The
human-driven label comes from Jeremy's contemporaneous report; the exact
screen, terminal state, and LAN-versus-relay transport remain unverified.

The first recording is labeled **human-driven real usage**. Power Profiler was
configured for 60 seconds and its trace envelope ran from
`2026-08-05T07:15:04.693+09:00` through
`2026-08-05T07:16:06.646+09:00` (61.953843 seconds including instrument
attachment and teardown). Its 60 process-QoS windows contain 14.070230960
CPU-seconds: 23.450385% average over the configured interval, or 22.710828%
over the full trace envelope. The highest window of at least 500 ms was
127.254343% across 0.961855125 seconds at trace offset 60.013635541, showing a
short multicore burst rather than a one-minute average. Thermal state remained
`Nominal` for the complete envelope.

Power Profiler's relative process CPU-impact series had a duration-weighted
mean of 3.336518 and range 0.0–30.0 in Instruments impact units. It reported
`0.0%/hr` system power while the device was USB-attached/charging with display
brightness at 99%, so that is not an absolute battery result. This template did
not expose process watts or interval mWh; its value cannot be directly compared
with the stale resource report's 60.30 mWh.

The sequential second recording is labeled **human-driven continuation;
idle/control state unverified**. Saving the first trace created a 22.979-second
gap before Activity Monitor ran for a configured 30 seconds, from
`2026-08-05T07:16:29.625+09:00` through
`2026-08-05T07:17:00.506+09:00` (30.881049-second envelope). Process cumulative
CPU advanced by 10.898312459 seconds, equal to 35.291264% over the envelope;
the instrument's duration-weighted live samples averaged 36.467089% and ranged
from 28.900417% to 45.502580%. Physical footprint began at 70.563721 MiB,
peaked at 78.813721 MiB, and ended at 73.969971 MiB. It did not show monotonic
growth during this short interval.

The second interval began `Nominal`, changed to `Fair` after 19.111741583
seconds (approximately `2026-08-05T07:16:48.737+09:00`), and remained `Fair`
for its final 11.769307334 seconds. This is direct thermal evidence during
human-driven use, but it does not identify which app view or transport caused
the load. Neither interval reached the stale incident report's 50% CPU resource
threshold on average.

At `2026-08-05T07:19:42+09:00`, `devicectl` still found the same PID 47710
running. The installed app metadata was Kanna Staging 0.1.0 (1), bundle
`build.kanna.app.staging`. A metadata-only listing of `systemCrashLogs` found
only the seven existing Kanna reports dated 2026-08-04 and no new crash,
resource, or termination report. Although xctrace labels a successfully
detached target `exit(0)` in its recording metadata, the same-PID liveness check
proves the app did not terminate at the end of either interval.

These observations show materially elevated current-build CPU and a transition
to `Fair` thermal state under real human use, but no crash and no short-interval
footprint runaway. Because the protected screen/transport state was
intentionally not inspected, they do not establish that the proven JS output
cursor bug recurred or connect the 2026-08-04 fatal JS exception to CPU load.

### Second resource report and remaining current-build hot path

The additional device report was copied read-only to
`/tmp/KannaStaging.cpu_resource-2026-08-04-223616.ips` and inspected only as
process metadata and sampled stacks. Its SHA-256 is
`6157b64904f9b335abaac58d621d77ed17438e5cd2f3f1620919cd0e92775bbc`.
No terminal or network payload, input, credential, screenshot, or sampled
memory was read or retained.

The report belongs to stale-build PID 44158, not the crashing PID 43418. It
started at `2026-08-04T22:33:52.943+09:00`, 2.943 seconds after PID 43418's
fatal termination, and ran for 141.98 seconds before iOS recorded another CPU
resource violation at 22:36. The process used 90 CPU-seconds during the
threshold interval (63% average) and 97.916 CPU-seconds in total. Thermal
pressure was again advisory level 20, energy was 44.69 mWh, and physical
footprint grew from 50.77 MB to 108.36 MB with a 123.08 MB maximum. All 25
sampled process states were active.

The new report has the same bundle build, executable slice UUID, and
UUID-relative React-runtime/Hermes-heavy stack chain as the original PID 43418
report. Absolute addresses and sample counts differ because this is a new
process with ASLR. This establishes that the stale-build CPU hot path recurred
immediately after relaunch. It does not make the preceding fatal JavaScript
exception its cause: the crash report still contains no JavaScript exception
message, and PID 44158 reached the CPU threshold without a matching fatal
report.

After the first cursor/coalescing fix, a second current-build profile attached
to installed PID 47907 without inspecting the app UI or content. The interval
is labeled **post-first-fix current state; view and transport unverified**.
Power Profiler was configured for 60 seconds; its trace envelope ran from
`2026-08-05T07:41:25.168+09:00` through
`2026-08-05T07:42:27.199+09:00` (62.031869 seconds). The 60 configured
process-QoS windows contain 30.457923128 CPU-seconds: 50.763205% average over
the configured duration, or 49.100444% over the complete envelope. Thermal
state was `Critical` for the complete envelope.

A consecutive Activity Monitor recording ran from
`2026-08-05T07:42:39.385+09:00` through
`2026-08-05T07:43:10.284+09:00` (30.899024 seconds). Cumulative process CPU
advanced by 9.554203124 seconds, or 30.920728% over the envelope. Physical
footprint increased from 81.8605 MiB to 91.0011 MiB, also its maximum, and
thermal state remained `Critical`. The same PID was alive after both
Instruments detachments, and no new Kanna `.ips` report appeared.

The stack-only Time Profiler export contains 19.920 seconds of samples:
17.141 seconds on the React Native JavaScript thread, 0.784 seconds on the
main thread, and 0.407 seconds in Hermes Hades GC. Overlapping symbol groups
account for 17.723 seconds in React/Fabric, 2.672 seconds in Hermes array work,
1.788 seconds in garbage collection, 0.838 seconds in object-spread helpers,
and 0.532 seconds in string operations. Native WebView/WebKit symbols account
for only 0.293 seconds. Initial samples also pass through React Native animated
event listener teardown. A metadata-only network instrument showed continuous
cellular TLS activity, but transport and terminal state remain unverified; no
endpoint or payload was retained.

The complete code path explains those samples. Each LAN or relay terminal
`output` frame called `mobileController`'s `appendTaskTerminal`. Although the
first fix bounded retained-string copying, `sessionStore.appendTaskTerminal`
still rebuilt and published the global session snapshot for every frame.
`AppContent` consumes that snapshot through `useSyncExternalStore`, so every
PTY frame invalidated the application React tree, including navigation,
`TaskScreen`, WebView props, and React Native animated bindings. The same
global subscription in `appModel` also invoked persisted-context projection,
comparison, and serialization for every frame. This matches the dominant
React/Fabric, array/object-copy, GC, and animated-listener stacks; xterm's
native WebView cost was comparatively small.

The remaining fix therefore keeps terminal bytes on their stream boundary.
The store retains every frame in an immutable segmented buffer and publishes
live output through a dedicated terminal-output source. The mounted
`TerminalWebView` owns that subscription and its cleanup, applies the existing
authoritative cursor/epoch mutation planner, coalesces only before xterm is
ready, and injects each subsequent frame once. Live frames no longer publish
global navigation/application state and no longer trigger unrelated context
persistence. Snapshot, status, error, selection, reconnect, and cleanup
transitions still publish global state. This adds no polling, delay, throttle,
optimistic echo, dropped frame, or hidden error, and preserves the reviewed
authoritative-output cursor and lifecycle behavior.

The causal regression sends 10,000 frames and proves 10,000 terminal-source
notifications with zero global application-state notifications. A 4,000-frame
WebView burst proves one authoritative pre-ready replacement followed by one
xterm append per ready frame, without serializing retained history per frame.
The segmented-buffer test uses a 750,001-character snapshot plus 10,000 frames
and proves per-frame scanning stays at or below the 64 KiB segment target,
while snapshot and completed-segment references remain stable and eviction
keeps complete frames and the logical cursor. The real remote E2E boundary
also passes across mobile client, relay, server, daemon, PTY, authoritative
no-echo input, output burst, and terminal remount.

An after-fix physical-device profile remains required before this revision is
merge-ready. From `2026-08-05T07:55+09:00` through
`2026-08-05T08:05:57+09:00`, CoreDevice continued to enumerate Jerome's
iPhone 15 (iPhone16,1, iOS 26.5.2) but marked it unavailable. The host USB
inventory contained no iPhone entry, confirming a physical-connectivity
blocker rather than an app state. The canonical reinstall stopped safely with
`No attached iPhone devices were found`; no alternate install path was used.
Profiling will resume after the phone is reattached and unlocked.

### Dedicated-subscription after-fix physical profile (2026-08-05)

Jerome's iPhone became available again, so the dirty task worktree was built,
installed, and launched through the canonical self-contained
`./kd mobile run --device --staging --install` path. The installed Release
bundle is Kanna Staging 0.1.0 (1), bundle `build.kanna.app.staging`; the app and
matching dSYM both have arm64 UUID
`16E6C734-CA77-3A94-BB8A-89CE11EEC3E6`. The build was made from HEAD
`49f69f75edbb34f3c0e2b84dce97734b00946118` plus the preserved scoped dirty
changes documented in this section. The change is JavaScript-only, so the
mobile `runtimeVersion` was correctly left unchanged.

The first launched process was suspended before Instruments attached. A
metadata-only foreground relaunch produced PID 48680; neither operation read
the accessibility hierarchy or app screen. Both fixed-duration recordings
then attached to that same PID without inspecting or exporting terminal
contents, input, credentials, screenshots, sampled memory, network endpoints,
or payloads. Because the protected UI was deliberately not inspected, this
run is labeled **dedicated-subscription after-fix current state; exact view and
LAN-versus-relay transport unverified**.

Power Profiler was configured for 60 seconds and its trace envelope ran from
`2026-08-05T11:48:00.829+09:00` through
`2026-08-05T11:49:02.730+09:00` (61.901200 seconds). The process-QoS rows
contain 14.604050154 CPU-seconds: 24.340084% average over the configured
interval, or 23.592515% over the complete envelope. The highest window of at
least 500 ms was 54.285330% across 0.911698417 seconds at trace offset
0.985343833. Process CPU-impact had a duration-weighted mean of 1.072312 and a
range of 0.1-8.0 in Instruments impact units. Thermal state remained `Nominal`
for the complete envelope.

The sequential Activity Monitor trace ran from
`2026-08-05T11:49:12.389+09:00` through
`2026-08-05T11:49:43.151+09:00` (30.762163 seconds). Cumulative process CPU
advanced by 1.306453833 seconds, or 4.246950% over the envelope; the
duration-weighted live samples averaged 4.338784% and ranged from 1.748623% to
8.789096%. Physical footprint began at 62.985458 MiB, peaked at 63.001083 MiB,
and ended at 60.876083 MiB. Thermal state remained `Nominal` for the complete
interval.

Against the immediately preceding post-first-fix profile, configured-interval
Power Profiler CPU fell from 50.763205% to 24.340084% (52.052% lower), while
the consecutive Activity Monitor envelope fell from 30.920728% to 4.246950%
(86.265% lower). The previous 30-second footprint increased from 81.8605 MiB
to 91.0011 MiB and thermal state remained `Critical`; this run stayed within a
0.015625 MiB peak band, ended 2.109375 MiB below its start, and stayed
`Nominal` throughout.

Most importantly for the causal React hot path, the Power Profiler stack-only
export fell from 19.920 seconds of total sampled execution to 2.749 seconds.
React Native's JavaScript thread fell from 17.141 seconds to 1.211 seconds
(92.935% lower), and Hermes Hades GC fell from 0.407 seconds to 0.041 seconds.
Main-thread sampling remained comparable (0.784 seconds before and 0.749
seconds after). This selective collapse of JavaScript-thread work, together
with the store regression proving that terminal frames no longer publish the
global React snapshot, materially closes the proven React invalidation hot
path rather than merely moving work onto the main or WebView thread.

PID 48680 was still alive after both Instruments detachments. A metadata-only
listing of `systemCrashLogs` found the same seven Kanna reports dated
2026-08-04 and no new crash, CPU-resource, or termination report. As in the
earlier traces, Instruments records a successful detach as `exit(0)` in trace
metadata; same-PID liveness proves the app did not exit. No current fatal
JavaScript exception was reproduced, and this after-fix evidence still does
not connect the stale fatal exception to the stale CPU incidents.

The traces and aggregate-only XML exports remain under `/private/tmp` and are
not committed. They contain process metadata and native stack symbols but no
terminal payload. Exact protected workload state was not observable without
violating the incident's data-handling constraint, so the deterministic burst
tests and the real mobile-client -> relay -> server -> daemon -> PTY boundary
remain the reproducible workload evidence paired with this physical-device
profile.
