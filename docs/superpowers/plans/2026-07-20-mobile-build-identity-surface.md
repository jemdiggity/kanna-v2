# Mobile Build Identity Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an expandable mobile More-screen surface that identifies the installed native build and exact running Expo bundle for OTA validation.

**Architecture:** A focused adapter converts Expo Application, Expo Updates, and Kanna environment values into a plain build-identity model. A self-contained React Native panel owns disclosure and clipboard feedback, while `MoreScreen` only places the panel after repository commands.

**Tech Stack:** React Native, TypeScript, Expo SDK 57, `expo-application`, `expo-updates`, `expo-clipboard`, Vitest

---

## File Responsibilities

- `apps/mobile/src/lib/updates/buildIdentity.ts`: read and normalize native build and current Expo bundle identity.
- `apps/mobile/src/lib/updates/buildIdentity.test.ts`: cover OTA, embedded, Metro, and missing-value normalization.
- `apps/mobile/src/components/BuildInfoPanel.tsx`: render collapsed/expanded build details and copy feedback.
- `apps/mobile/src/components/BuildInfoPanel.test.tsx`: cover disclosure, exact ID rendering, copying, and feedback reset.
- `apps/mobile/src/screens/MoreScreen.tsx`: place the panel after repository command content.
- `apps/mobile/src/screens/MoreScreen.test.tsx`: prove the More screen includes the focused panel without regressing commands.
- `apps/mobile/src/e2eTestIds.ts`: centralize stable identifiers for the disclosure, details, update ID, and copy hint.
- `apps/mobile/package.json` and `pnpm-lock.yaml`: add the Expo SDK-compatible `expo-application` native dependency.
- `apps/mobile/src/mobileEnvironments.json` and `apps/mobile/src/mobileAppConfig.test.ts`: bump and lock the native runtime compatibility version.
- `apps/mobile/README.md`: document where and how operators interpret build identity.

### Task 1: Normalize the current native and Expo update identity

**Files:**
- Create: `apps/mobile/src/lib/updates/buildIdentity.test.ts`
- Create: `apps/mobile/src/lib/updates/buildIdentity.ts`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing adapter tests**

Create tests that call `buildIdentity` with explicit inputs and assert:

```ts
expect(buildIdentity({
  nativeApplicationVersion: "2.4.0",
  nativeBuildVersion: "108",
  updatesEnabled: true,
  isEmbeddedLaunch: false,
  updateId: "84667f93-5c7b-45fb-9f78-7045160cb842",
  runtimeVersion: "2.1.2",
  channel: "staging",
  appEnvironment: "staging",
  configuredRuntimeVersion: "2.1.2",
  configuredChannel: "staging"
})).toEqual({
  nativeVersion: "2.4.0",
  nativeBuild: "108",
  nativeSummary: "2.4.0 (108)",
  runtimeVersion: "2.1.2",
  environment: "staging",
  channel: "staging",
  source: {
    kind: "ota",
    label: "84667f93-5c7b-45fb-9f78-7045160cb842",
    updateId: "84667f93-5c7b-45fb-9f78-7045160cb842"
  }
});
```

Add separate cases asserting `Embedded bundle`, `Development bundle (Metro)`, and `Unknown` fallbacks, including configured runtime/channel fallback when native Updates values are absent.

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/lib/updates/buildIdentity.test.ts`

Expected: FAIL because `./buildIdentity` does not exist.

- [ ] **Step 3: Add the supported native dependency**

Run: `pnpm --dir apps/mobile add expo-application@~57.0.0`

Expected: `apps/mobile/package.json` and `pnpm-lock.yaml` include the SDK 57-compatible package.

- [ ] **Step 4: Implement the plain adapter and default native reader**

Define `BuildIdentityInput`, `BuildIdentity`, and a discriminated `BuildSource` union. Implement `buildIdentity(input)` with exact source ordering and fallbacks from the design. Implement `getCurrentBuildIdentity()` using:

```ts
import * as Application from "expo-application";
import * as Updates from "expo-updates";
import { readExpoConfig } from "../expoConfig";
import {
  readKannaExpoExtra,
  resolveMobileAppEnvironment
} from "../../mobileEnvironment";

const extra = readKannaExpoExtra(readExpoConfig());
const environment = resolveMobileAppEnvironment(extra?.appEnv);

return buildIdentity({
  nativeApplicationVersion: Application.nativeApplicationVersion,
  nativeBuildVersion: Application.nativeBuildVersion,
  updatesEnabled: Updates.isEnabled,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  updateId: Updates.updateId,
  runtimeVersion: Updates.runtimeVersion,
  channel: Updates.channel,
  appEnvironment: extra?.appEnv ?? environment.name,
  configuredRuntimeVersion: extra?.runtimeVersion ?? environment.runtimeVersion,
  configuredChannel: extra?.ota?.channel ?? environment.otaChannel
});
```

- [ ] **Step 5: Run the adapter test and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/lib/updates/buildIdentity.test.ts`

Expected: all adapter cases PASS.

- [ ] **Step 6: Commit the adapter slice**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/src/lib/updates/buildIdentity.ts apps/mobile/src/lib/updates/buildIdentity.test.ts
git commit -m "feat(mobile): expose current build identity"
```

### Task 2: Add the expandable build-information panel

**Files:**
- Create: `apps/mobile/src/components/BuildInfoPanel.test.tsx`
- Create: `apps/mobile/src/components/BuildInfoPanel.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write the failing component tests**

Render `BuildInfoPanel` with an injected OTA identity and `copyUpdateId` spy. Assert the collapsed tree contains `About this build` and `2.4.0 (108)` but not `Runtime`. Press the disclosure, then assert the tree contains `Runtime`, `Environment`, `Channel`, and the complete UUID. Press the update-ID control and assert:

```ts
expect(copyUpdateId).toHaveBeenCalledWith(
  "84667f93-5c7b-45fb-9f78-7045160cb842"
);
expect(copyHintText()).toBe("Copied");
```

Use fake timers to advance 2 seconds and assert the hint returns to `Tap to copy`. Add a separate embedded identity assertion proving there is no copy action.

- [ ] **Step 2: Run the panel test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/components/BuildInfoPanel.test.tsx`

Expected: FAIL because `BuildInfoPanel` does not exist.

- [ ] **Step 3: Add stable build-information test IDs**

Add these keys to `MOBILE_E2E_IDS`:

```ts
buildInfoToggle: "mobile.build-info.toggle",
buildInfoDetails: "mobile.build-info.details",
buildInfoUpdateId: "mobile.build-info.update-id",
buildInfoCopyHint: "mobile.build-info.copy-hint",
```

- [ ] **Step 4: Implement the expandable panel**

Implement `BuildInfoPanel` with optional injectable props:

```ts
interface BuildInfoPanelProps {
  identity?: BuildIdentity;
  copyUpdateId?(value: string): Promise<void>;
}
```

Default `identity` to `getCurrentBuildIdentity()` and `copyUpdateId` to `Clipboard.setStringAsync`. Keep local `expanded` and `copied` state. Render labeled rows for Native, Runtime, Environment, Channel, and Running source. Only the OTA source is pressable; await a successful clipboard write, show `Copied`, and reset it after 2 seconds. Catch clipboard failures without affecting the screen.

- [ ] **Step 5: Run the panel test and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/components/BuildInfoPanel.test.tsx`

Expected: all disclosure and clipboard cases PASS with no React act warnings.

- [ ] **Step 6: Commit the component slice**

```bash
git add apps/mobile/src/components/BuildInfoPanel.tsx apps/mobile/src/components/BuildInfoPanel.test.tsx apps/mobile/src/e2eTestIds.ts
git commit -m "feat(mobile): add build information panel"
```

### Task 3: Place build information on the More screen

**Files:**
- Modify: `apps/mobile/src/screens/MoreScreen.test.tsx`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`

- [ ] **Step 1: Replace the obsolete absence test with a failing placement test**

Mock `../components/BuildInfoPanel` as the host string `BuildInfoPanel`. Replace `does not expose OTA diagnostics` with a test that renders `MoreScreen` and asserts exactly one `BuildInfoPanel` node appears after the repository-command groups in the rendered tree.

- [ ] **Step 2: Run the More-screen test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/screens/MoreScreen.test.tsx`

Expected: FAIL because `MoreScreen` does not render `BuildInfoPanel`.

- [ ] **Step 3: Render the panel after command content**

Import `BuildInfoPanel` and render `<BuildInfoPanel />` after the command status/section branch but inside the existing `styles.wrap` container.

- [ ] **Step 4: Run the focused UI tests and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/screens/MoreScreen.test.tsx src/components/BuildInfoPanel.test.tsx src/lib/updates/buildIdentity.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the More-screen integration**

```bash
git add apps/mobile/src/screens/MoreScreen.tsx apps/mobile/src/screens/MoreScreen.test.tsx
git commit -m "feat(mobile): show build identity in more"
```

### Task 4: Bump native runtime compatibility and document operator interpretation

**Files:**
- Modify: `apps/mobile/src/mobileAppConfig.test.ts`
- Modify: `apps/mobile/src/mobileEnvironments.json`
- Modify: `apps/mobile/README.md`

- [ ] **Step 1: Update the configuration test first**

Change every expected `runtimeVersion` in `mobileAppConfig.test.ts` from `2.1.1` to `2.1.2`.

- [ ] **Step 2: Run the configuration test and verify RED**

Run: `pnpm --dir apps/mobile test -- src/mobileAppConfig.test.ts`

Expected: FAIL because all three environment records still provide `2.1.1`.

- [ ] **Step 3: Bump every environment runtime version**

Change `dev`, `staging`, and `prod` in `mobileEnvironments.json` from `2.1.1` to `2.1.2`.

- [ ] **Step 4: Run the configuration test and verify GREEN**

Run: `pnpm --dir apps/mobile test -- src/mobileAppConfig.test.ts`

Expected: all mobile app configuration tests PASS.

- [ ] **Step 5: Document the operator-facing surface**

Add an `About This Build` section to `apps/mobile/README.md` stating that More → About this build shows the installed native version/build, runtime, environment/channel, and running source. Define a UUID as a downloaded OTA update, `Embedded bundle` as code packaged with the binary, and `Development bundle (Metro)` as a dev-client JavaScript session. State that tapping a UUID copies the exact value.

- [ ] **Step 6: Commit runtime and documentation changes**

```bash
git add apps/mobile/src/mobileAppConfig.test.ts apps/mobile/src/mobileEnvironments.json apps/mobile/README.md
git commit -m "docs(mobile): explain build identity diagnostics"
```

### Task 5: Verify the complete mobile change

**Files:**
- Verify only

- [ ] **Step 1: Run all focused tests**

Run:

```bash
pnpm --dir apps/mobile test -- \
  src/lib/updates/buildIdentity.test.ts \
  src/components/BuildInfoPanel.test.tsx \
  src/screens/MoreScreen.test.tsx \
  src/mobileAppConfig.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run mobile type checking**

Run: `pnpm --dir apps/mobile typecheck`

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 3: Run the complete mobile unit suite**

Run: `pnpm --dir apps/mobile test`

Expected: the full mobile Vitest suite PASSes.

- [ ] **Step 4: Inspect repository hygiene**

Run: `git diff --check origin/feat/mobile-ota-release-hardening...HEAD` and `git status --short --branch`.

Expected: no whitespace errors, no unintended files, no generated iOS tree, and no production OTA publication or device-launch artifacts.
