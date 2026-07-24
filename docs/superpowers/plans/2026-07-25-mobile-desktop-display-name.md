# Mobile Desktop Display Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trusted mobile Bonjour discovery display the desktop server's human-readable name instead of its stable `desktop-…` Bonjour instance identifier.

**Architecture:** Keep Bonjour TXT identity and `/v1/status.desktopId` matching as the trust boundary. Extend the existing status probe to parse a non-empty `desktopName`, then return that validated name to the machine inventory.

**Tech Stack:** TypeScript, React Native/Expo, Vitest, pnpm

---

### Task 1: Use the validated status display name

**Files:**
- Modify: `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`
- Modify: `apps/mobile/src/lib/discovery/trustedBonjour.ts`

- [ ] **Step 1: Write the failing regression tests**

In `apps/mobile/src/lib/discovery/trustedBonjour.test.ts`, change the successful
status fixture and Bonjour service so they expose different names:

```ts
const fetchImpl = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    desktopId: "desktop-1",
    desktopName: "  Gu’s MacBook Pro  "
  })
}));
const service: BonjourService = {
  name: "desktop-1",
  type: "_kanna-mobile._tcp.",
  host: "studio.local",
  port: 48120,
  txt: { desktopId: "desktop-1" }
};
```

Assert the resolved endpoint contains:

```ts
displayName: "Gu’s MacBook Pro"
```

Add a test proving a matching desktop ID with a blank status name is rejected:

```ts
it("rejects a trusted service when status has no usable desktop name", async () => {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      desktopId: "desktop-1",
      desktopName: "   "
    })
  }));

  await expect(resolveTrustedBonjourEndpoint({
    fetchImpl,
    services: [{
      name: "desktop-1",
      type: "_kanna-mobile._tcp.",
      host: "studio.local",
      port: 48120,
      txt: { desktopId: "desktop-1" }
    }],
    trustedDesktopIds,
    preferredDesktopId: null
  })).resolves.toBeNull();
});
```

Add a non-empty `desktopName` to every other successful status fixture in the
file because a supported status response must contain both fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/discovery/trustedBonjour.test.ts
```

Expected: FAIL because the resolved endpoint returns the Bonjour instance name
`desktop-1`, and the blank-name response is accepted.

- [ ] **Step 3: Implement the minimal status-name validation**

In `apps/mobile/src/lib/discovery/trustedBonjour.ts`, replace the endpoint
mapping in `validateTrustedService` with:

```ts
const displayName =
  typeof status?.desktopName === "string"
    ? status.desktopName.trim()
    : "";
return status?.desktopId === desktopId && displayName
  ? { baseUrl, desktopId, displayName }
  : null;
```

Extend `fetchStatus`'s return type to include the untrusted response field:

```ts
): Promise<{
  desktopId?: unknown;
  desktopName?: unknown;
} | null> {
```

Cast parsed objects to the same shape:

```ts
return body && typeof body === "object"
  ? (body as { desktopId?: unknown; desktopName?: unknown })
  : null;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/discovery/trustedBonjour.test.ts
```

Expected: all tests in `trustedBonjour.test.ts` PASS.

- [ ] **Step 5: Run mobile package verification**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
```

Expected: TypeScript exits successfully and the complete mobile Vitest suite
passes without regressions.

- [ ] **Step 6: Commit the implementation**

```bash
git add \
  apps/mobile/src/lib/discovery/trustedBonjour.ts \
  apps/mobile/src/lib/discovery/trustedBonjour.test.ts \
  docs/superpowers/plans/2026-07-25-mobile-desktop-display-name.md
git commit -m "fix(mobile): preserve desktop display names"
```
