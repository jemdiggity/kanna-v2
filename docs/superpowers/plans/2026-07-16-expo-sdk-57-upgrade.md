# Expo SDK 57 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Kanna Mobile from Expo SDK 53 to SDK 57 without changing its environment, OTA, native identity, or `kd` workflow semantics.

**Architecture:** Upgrade dependencies sequentially through every supported Expo major, then regenerate the untracked native iOS project from the final SDK 57 config. Strengthen tests at the custom config-plugin and Expo CLI launch seams so SDK template drift or loss of the upstream physical-device termination behavior is visible.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript, Vitest, pnpm, Expo CNG/config plugins, Xcode 26.

---

### Task 1: Record SDK-sensitive contracts

**Files:**
- Modify: `apps/mobile/src/bonjourPlugin.test.ts`
- Modify: `tools/kd/src/runtime/mobile-device.test.ts` or the existing nearest `kd` device-flow test

- [ ] Add a fixture matching the SDK 57 AppDelegate and bundle phase and assert
  that the Bonjour plugin injects the Metro host/port bridge exactly once.
- [ ] Add a test that inspects the installed SDK 57 Expo CLI device launcher and
  asserts its already-running-app termination occurs before launch, without
  invoking `devicectl` or a physical device.
- [ ] Run the focused tests before implementation and confirm they fail against
  the SDK 53 dependency/template state.

### Task 2: Upgrade through Expo SDK 54

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify if required: `pnpm-workspace.yaml`

- [ ] Run `pnpm --dir apps/mobile add expo@~54.0.0`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --fix`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --check` and resolve only
  SDK 54 compatibility errors.
- [ ] Run the mobile typecheck and custom plugin/config tests.

### Task 3: Upgrade through Expo SDK 55

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify if required: `pnpm-workspace.yaml`

- [ ] Run `pnpm --dir apps/mobile add expo@~55.0.0`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --fix`.
- [ ] Confirm the app and custom native module remain compatible with the
  mandatory New Architecture.
- [ ] Run Expo dependency validation, mobile typecheck, and focused tests.

### Task 4: Upgrade through Expo SDK 56

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify if required: `pnpm-workspace.yaml`

- [ ] Run `pnpm --dir apps/mobile add expo@~56.0.0`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --fix`.
- [ ] Validate React 19.2, React Native 0.85, Hermes v1, and Expo Modules Core
  compatibility through typecheck, tests, and clean prebuild.

### Task 5: Upgrade to Expo SDK 57

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Modify if required: `pnpm-workspace.yaml`

- [ ] Run `pnpm --dir apps/mobile add expo@~57.0.0`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --fix`.
- [ ] Run `pnpm --dir apps/mobile exec expo install --check` and
  `pnpm --dir apps/mobile exec expo-doctor` until both report no dependency or
  project-configuration errors.
- [ ] Confirm package resolution uses SDK 57, React Native 0.86, React 19.2,
  and SDK-compatible Expo modules/tooling.

### Task 6: Bump OTA native runtime and documentation

**Files:**
- Modify: `apps/mobile/src/mobileEnvironments.json`
- Modify: `apps/mobile/src/mobileAppConfig.test.ts`
- Modify: `apps/mobile/README.md`
- Modify: `docs/2026-07-07-kanna-mobile-app-store-submission.md`
- Modify: `docs/specs/mobile-ota-updates.md`

- [ ] Change dev, staging, and production `runtimeVersion` from `1.0.0` to
  `2.0.0` and update direct source-of-truth assertions.
- [ ] Update SDK-specific documentation to Expo 57 / React Native 0.86 /
  React 19.2 and describe the required new native build.
- [ ] Leave generic protocol fixtures that intentionally use `1.0.0` unchanged.

### Task 7: Sync and validate native iOS generation

**Files:**
- Modify if SDK template compatibility requires it: `apps/mobile/plugins/withKannaBonjour.js`
- Modify if SDK config-plugin compatibility requires it: `apps/mobile/plugins/withKannaNativeIdentity.js`
- Do not commit: `apps/mobile/ios/**`

- [ ] Run `KANNA_APP_ENV=dev pnpm --dir apps/mobile exec expo prebuild --platform ios`.
- [ ] Inspect the generated AppDelegate, native Bonjour sources, bundle phase,
  Info.plist, entitlements, Podfile, and app target identity.
- [ ] Repeat config/prebuild inspection for staging and production identities
  where it can be done without signing or launching a device.
- [ ] Run a simulator Debug build with signing disabled where practical.
- [ ] Remove generated native directories after verification.

### Task 8: Full verification and scope review

**Files:**
- Review all modified files

- [ ] Run `pnpm --dir apps/mobile test`.
- [ ] Run `pnpm --dir apps/mobile typecheck`.
- [ ] Run the focused `kd` tests for mobile device command construction and
  execution.
- [ ] Run `pnpm test` if time and local resources permit.
- [ ] Review `git diff` and confirm no physical-device command ran, no generated
  native tree is tracked, no Firebase/relay/identity value changed, and no
  temporary `kd` timeout/payload-recovery code entered the diff.
- [ ] Report the human-only physical-device check: start an installed Kanna Dev,
  run `./kd mobile run --device`, and verify termination/relaunch completes
  without hanging at `Connecting to`.
