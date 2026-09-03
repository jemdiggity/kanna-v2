# Task 3acdd1ab: iOS simulator support for `kd mobile run`

## Goal

Make `./kd mobile run --simulator [<udid|name>]` the canonical way to select, boot, build, install, and launch the mobile dev client in an iOS Simulator while starting the same desktop-side Kanna services as the existing mobile development flow.

## Scope and constraints

- Reuse the existing mobile build/environment/owner/cloud resolution and device-run flow rather than creating a separate implementation.
- Select an explicit simulator by UDID or name, or default to a booted simulator and then the newest available iPhone; boot it when needed and plan the simulator install/launch commands.
- Make a missing target error list both physical-device and simulator choices.
- Cover CLI parsing, target resolution, and boot/install command planning in `tools/kd/tests`; update `docs/dev/dev-workflow.md` and `AGENTS.md` to match the supported command.
- Do not change mobile `runtimeVersion`, release/OTA behavior, or introduce build-time Homebrew dependencies.

## Done when

`./kd mobile run --simulator` boots a simulator, installs and opens the dev client, starts the desktop-side server, the relevant kd tests and `./kd test all` pass, and this document records the real simulator command and outcome (including whether the reported Expo SDK 57/Xcode 26 incompatibility is a kd-selectable toolchain issue or an upstream blocker).

## Verification record

On 2026-09-03, `./kd mobile run --simulator` selected the newest available
iPhone (`iPhone 17 Pro`, iOS 26.2,
`F979BDE0-C85A-4097-B031-46F6C0EF6CBF`), booted it from `Shutdown`, waited for
`bootstatus`, and opened Simulator. It then started this worktree's kd-managed
stack on its reserved ports (including Metro on 8116 and the desktop/server on
48131), completed Expo prebuild and CocoaPods, and invoked the shared install
path as `expo run:ios --device F979BDE0-C85A-4097-B031-46F6C0EF6CBF --port
8116` with the Dev identity.

The native build failed before app installation in the unchanged transitive
`expo-modules-jsi` 57.0.5 dependency at `RuntimeScheduler.h:61`: the Xcode
compiler rejected `SWIFT_RETURNS_RETAINED RuntimeScheduler()` because the
constructor does not return a `SWIFT_SHARED_REFERENCE` type. `xcodebuild`
exited 65, and `simctl get_app_container` confirmed that
`build.kanna.app.dev` was not installed. This exactly reproduces the report in
[Expo issue #49214](https://github.com/expo/expo/issues/49214).

The selected developer directory was
`/Applications/Xcode.app/Contents/Developer`, reporting Xcode 26.2 build 17C52
and Swift 6.2.3. `DEVELOPER_DIR` was unset, and both Spotlight and filesystem
checks found no alternate Xcode installation for kd to select. This is not a
simulator-target or command-planning defect: this checkout previously recorded
successful unpatched Expo SDK 57 builds under Xcode 26.6 in task `ac2b403e`,
and an Expo maintainer states that this SDK line requires Xcode 26.4 or newer
in [Expo issue #47539](https://github.com/expo/expo/issues/47539). On this
machine the remaining installation blocker is therefore the unsupported,
sole installed Xcode 26.2 toolchain. kd cannot select a compatible toolchain
until one is installed; changing/pinning native Expo dependencies would also
violate this task's explicit no-`runtimeVersion`-change constraint.

Automated verification completed successfully on 2026-09-03:

- `./kd test all`
- `pnpm --dir tools/kd typecheck`
- Focused kd suites for CLI parsing, simulator resolution/command planning,
  and task execution (82 tests total)
- `git diff --check`
