# Mobile Trusted LAN Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile app use remembered trusted desktop `kanna-server` LAN endpoints when signed in, while validating that the endpoint belongs to the expected desktop.

**Architecture:** Keep `kanna-server` desktop-only. Mobile remains a client that combines cloud task indexing with a trusted LAN resolver. The resolver chooses a non-loopback configured LAN URL when present, otherwise probes persisted trusted desktop endpoints and only uses one whose `/v1/status.desktopId` matches the trusted desktop.

**Tech Stack:** React Native/Expo mobile app, TypeScript, Vitest/Jest-style mobile tests, existing `KannaClient` and LAN/remote transports.

---

### Task 1: Trusted LAN Resolver Tests

**Files:**
- Modify: `apps/mobile/src/App.test.tsx`
- Modify: `apps/mobile/src/appModel.ts`

- [ ] **Step 1: Write failing tests**

Add tests that cover:
- signed-in cloud mode with no cloud tasks probes persisted trusted LAN endpoints and reads tasks from the matching desktop;
- a persisted endpoint is ignored when `/v1/status.desktopId` does not match the trusted desktop record.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir apps/mobile test src/App.test.tsx
```

Expected: the new tests fail because the current fallback uses the first stored endpoint without probing or desktop-id validation.

- [ ] **Step 3: Implement minimal resolver**

In `apps/mobile/src/appModel.ts`, add a small trusted LAN endpoint resolver used by signed-in fallback:
- if `baseUrl` is non-loopback, keep using it;
- otherwise probe the selected trusted desktop first, then the remaining trusted desktops;
- call `/v1/status` on each endpoint;
- accept only endpoints whose returned `desktopId` matches the trusted desktop;
- fall back to the original loopback URL if none match.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
pnpm --dir apps/mobile test src/App.test.tsx
```

Expected: all `App.test.tsx` tests pass.

### Task 2: Verification

**Files:**
- Verify: `apps/mobile/src/App.test.tsx`
- Verify: `apps/mobile/src/state/sessionStore.test.ts`
- Verify: `apps/mobile/src/components/AccountSheet.test.tsx`
- Verify: `apps/mobile`

- [ ] **Step 1: Run focused regression tests**

```bash
pnpm --dir apps/mobile test src/state/sessionStore.test.ts src/App.test.tsx src/components/AccountSheet.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: typecheck passes.
