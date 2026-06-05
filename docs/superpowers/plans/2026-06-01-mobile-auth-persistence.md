# Mobile Auth Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the mobile Firebase login session across app restarts.

**Architecture:** Keep the existing mobile auth session API. Add a small React Native Firebase `Persistence` adapter backed by AsyncStorage, then initialize Firebase Auth with that persistence in `createConfiguredMobileAuthSession`. Fall back to `getAuth` if the app already initialized Auth in tests or hot reload.

**Tech Stack:** Expo React Native, Firebase Auth v12, AsyncStorage, Vitest.

---

### Task 1: Persistence Adapter

**Files:**
- Create: `apps/mobile/src/lib/firebase/authPersistence.ts`
- Test: `apps/mobile/src/lib/firebase/authPersistence.test.ts`

- [ ] **Step 1: Write failing tests**

Test that the adapter:
- reports type `"LOCAL"`;
- writes JSON values to AsyncStorage;
- reads JSON values back;
- removes values;
- returns `null` for missing or invalid stored values.

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --dir apps/mobile test src/lib/firebase/authPersistence.test.ts
```

Expected: fail because `authPersistence.ts` does not exist.

- [ ] **Step 3: Implement adapter**

Create `createReactNativeAuthPersistence(storage)` returning a Firebase-compatible persistence class with `_isAvailable`, `_set`, `_get`, `_remove`, `_addListener`, and `_removeListener`.

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --dir apps/mobile test src/lib/firebase/authPersistence.test.ts
```

Expected: pass.

### Task 2: Firebase Auth Wiring

**Files:**
- Modify: `apps/mobile/src/lib/firebase/sdk.ts`
- Test: `apps/mobile/src/lib/firebase/sdk.test.ts`

- [ ] **Step 1: Write failing tests**

Mock `firebase/auth` and AsyncStorage. Assert that `createConfiguredMobileAuthSession()` calls `initializeAuth(app, { persistence })` before returning a session.

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --dir apps/mobile test src/lib/firebase/sdk.test.ts
```

Expected: fail because current code calls `getAuth(app)`.

- [ ] **Step 3: Implement wiring**

Import AsyncStorage, `initializeAuth`, and the new persistence adapter. Use `initializeAuth(app, { persistence: createReactNativeAuthPersistence(AsyncStorage) })`. If Auth is already initialized, catch Firebase's already-initialized error and use `getAuth(app)`.

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --dir apps/mobile test src/lib/firebase/sdk.test.ts
```

Expected: pass.

### Task 3: Verification

**Files:**
- Verify: `apps/mobile/src/lib/firebase/authPersistence.test.ts`
- Verify: `apps/mobile/src/lib/firebase/sdk.test.ts`
- Verify: mobile app typecheck

- [ ] **Step 1: Run focused tests**

```bash
pnpm --dir apps/mobile test src/lib/firebase/authPersistence.test.ts src/lib/firebase/sdk.test.ts src/lib/firebase/auth.test.ts src/App.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: typecheck passes.
