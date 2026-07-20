# Mobile LAN Route Relay Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep signed-in account-owned tasks connected through the relay when their previously selected LAN route no longer has a validated endpoint.

**Architecture:** Preserve the existing cloud/LAN route selection and make the trusted-LAN boundary accurately report synchronous routability. `clientForDesktop()` will return a LAN client only for a currently validated URL; returning `null` lets the existing cloud fallback route handle account-owned tasks while leaving LAN-only tasks unavailable until discovery succeeds again.

**Tech Stack:** TypeScript, React Native/Expo mobile app, Vitest

---

## File structure

- Modify `apps/mobile/src/appModel.ts`: restrict per-desktop LAN clients to validated endpoint URLs.
- Modify `apps/mobile/src/appModel.cloudFallback.test.ts`: retain the signed-in/account-listed regression and assert relay attachment after LAN validation disappears.
- Add `docs/superpowers/plans/2026-07-20-mobile-lan-route-relay-fallback.md`: record this executable plan.

### Task 1: Route account-owned tasks through relay when LAN is unvalidated

**Files:**
- Modify: `apps/mobile/src/appModel.cloudFallback.test.ts:3929`
- Modify: `apps/mobile/src/appModel.ts:1028`

- [x] **Step 1: Complete the failing integration test**

Keep the existing test setup that signs in, loads an account desktop, merges its LAN task, removes Bonjour services, and refreshes desktop inventory. Capture the relay mock and assert that the task attaches through its cloud route:

```ts
const relayClient = createRelayClientMock();
const app = createAppModel({
  authSession,
  fetchImpl: lan.fetchImpl,
  persistence: {
    load: vi.fn().mockResolvedValue({
      selectedDesktopId: "desktop-lan",
      trustedDesktops: [],
      repoCreationProfiles: []
    }),
    save: vi.fn().mockResolvedValue(undefined)
  },
  options: {
    forceCloud: false,
    relayUrl: "wss://relay.test",
    taskIndex,
    bonjourBrowser,
    createRelayClient: () => relayClient
  }
});

// After the existing signed-in, account-inventory, and no-error assertions:
expect(relayClient.observeTaskAgent).toHaveBeenCalledWith(
  { desktopId: "desktop-lan", taskId: "local-task" },
  expect.any(Function)
);
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- appModel.cloudFallback.test.ts -t "does not disconnect an account-trusted task while its LAN endpoint is being re-resolved"
```

Expected: FAIL because the listener receives `No trusted desktop is available.` and the relay observer is not called.

- [x] **Step 3: Restrict per-desktop LAN routing to validated URLs**

Change `createTrustedLanFallbackClient().clientForDesktop()` in `apps/mobile/src/appModel.ts` so an unvalidated desktop is not presented as synchronously routable:

```ts
clientForDesktop(desktopId) {
  if (!getTrustedDesktopIds().includes(desktopId)) {
    return null;
  }
  const validatedBaseUrl = validatedBaseUrls.get(desktopId);
  return validatedBaseUrl ? clientForBaseUrl(validatedBaseUrl) : null;
}
```

Do not change the top-level resolving client. Its asynchronous request methods still perform Bonjour validation for inventory and ordinary LAN operations.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- appModel.cloudFallback.test.ts -t "does not disconnect an account-trusted task while its LAN endpoint is being re-resolved"
```

Expected: PASS. The account desktop remains visible, auth remains `signedIn`, the relay observer receives the owner desktop/local task route, and no disconnected error is emitted.

- [x] **Step 5: Run the relevant routing regression suites**

Run:

```bash
pnpm --dir apps/mobile test -- appModel.cloudFallback.test.ts src/lib/sources/cloudLanClient.test.ts
```

Expected: both test files PASS, including validated LAN preference and LAN-only unavailability coverage.

- [x] **Step 6: Run the full mobile verification**

Run:

```bash
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
```

Expected: the complete mobile unit suite and TypeScript typecheck PASS with no new warnings or errors.

- [x] **Step 7: Commit the implementation**

```bash
git add apps/mobile/src/appModel.ts apps/mobile/src/appModel.cloudFallback.test.ts docs/superpowers/plans/2026-07-20-mobile-lan-route-relay-fallback.md
git commit -m "fix(mobile): fall back to relay when LAN is unvalidated"
```
