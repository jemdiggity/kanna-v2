# Mobile Pairing Action Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Preferences → Mobile pairing button say “Refresh” while it would replace a visible pairing session and “Start pairing” otherwise.

**Architecture:** Keep the existing pairing-session state and backend command unchanged. Derive a component-level action label from `pairingCode` and `pairingExpired`, the same values that determine whether pairing credentials are rendered, so the label cannot drift from the visible UI.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vue Test Utils, happy-dom

---

### Task 1: Derive the pairing action label from visible session state

**Files:**
- Modify: `apps/desktop/src/components/__tests__/MobileAccessPanel.test.ts:26-40,60-80`
- Modify: `apps/desktop/src/components/MobileAccessPanel.vue:25-28,119-126`

- [x] **Step 1: Write the failing active-session and expiration assertions**

Change the active-session E2E-selector assertion to require `Refresh`, then extend the expiration test to require `Refresh` before expiry and `Start pairing` after expiry:

```ts
expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Refresh");

expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Refresh");
await vi.advanceTimersByTimeAsync(1_000);
expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Start pairing");
```

- [x] **Step 2: Run the focused test and verify the new assertions fail for the missing behavior**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/MobileAccessPanel.test.ts
```

Expected: FAIL because the active-session button still contains `Start pairing` instead of `Refresh`.

- [x] **Step 3: Add the minimal state-derived label**

Add immediately after the `pairingExpired` ref so the computed value derives from initialized reactive state:

```ts
const pairingActionLabel = computed(() =>
  props.pairingCode && !pairingExpired.value ? "Refresh" : "Start pairing"
);
```

Render it in the existing action button:

```vue
<button
  type="button"
  class="start-pairing"
  data-testid="mobile-access-start-pairing"
  @click="emit('start-pairing')"
>
  {{ pairingActionLabel }}
</button>
```

- [x] **Step 4: Run focused tests and verify they pass**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/MobileAccessPanel.test.ts
```

Expected: all `MobileAccessPanel` tests PASS with no warnings or errors.

- [x] **Step 5: Run desktop type checking and the complete desktop unit suite**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
pnpm --dir apps/desktop test
```

Expected: both commands exit successfully.

- [x] **Step 6: Review the final diff and commit the implementation**

Run:

```bash
git diff --check
git diff -- apps/desktop/src/components/MobileAccessPanel.vue apps/desktop/src/components/__tests__/MobileAccessPanel.test.ts
git add apps/desktop/src/components/MobileAccessPanel.vue apps/desktop/src/components/__tests__/MobileAccessPanel.test.ts docs/superpowers/plans/2026-07-23-mobile-pairing-action-label.md
git commit -m "fix(desktop): refresh active mobile pairing session"
```

Expected: the diff contains only the label derivation, focused test changes, and this plan; the commit succeeds.
