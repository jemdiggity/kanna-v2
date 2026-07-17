# Mobile Search Input Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Focus the mobile **Search tasks** input after every tap of the toolbar magnifying-glass action, including repeated taps while Search is already open.

**Architecture:** `App` will translate every search utility action into a monotonically increasing focus-request key while retaining the existing `showView("search")` navigation. `SearchScreen` will respond to each key with a `TextInput` ref and effect, so it can focus on initial mount and refocus without remounting or clearing search state.

**Tech Stack:** React 19, React Native 0.86, TypeScript, Vitest, `react-test-renderer`

---

## File Structure

- Create `apps/mobile/src/screens/SearchScreen.test.tsx`: component regression coverage for initial and repeated focus requests.
- Modify `apps/mobile/src/screens/SearchScreen.tsx`: accept the request key and focus the native text input when it changes.
- Modify `apps/mobile/src/App.component.test.tsx`: app-shell wiring regression coverage for repeated magnifier taps.
- Modify `apps/mobile/src/App.tsx`: own the request key, advance it on magnifier taps, and pass it to `SearchScreen`.

### Task 1: Make SearchScreen respond to focus requests

**Files:**
- Create: `apps/mobile/src/screens/SearchScreen.test.tsx`
- Modify: `apps/mobile/src/screens/SearchScreen.tsx`

- [x] **Step 1: Write the failing SearchScreen test**

Create `apps/mobile/src/screens/SearchScreen.test.tsx` with a React Native `TextInput` test double whose imperative `focus()` method is observable. Cover both the absence of a request and initial/repeated positive request keys:

```tsx
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  focus: vi.fn()
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    ScrollView: "ScrollView",
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
    TextInput: ReactModule.forwardRef(function TextInput(
      props: Record<string, unknown>,
      ref: import("react").ForwardedRef<{ focus(): void }>
    ) {
      ReactModule.useImperativeHandle(ref, () => ({ focus: harness.focus }));
      return ReactModule.createElement("TextInput", props);
    }),
    View: "View"
  };
});

vi.mock("../components/TaskList", () => ({ TaskList: "TaskList" }));

import { SearchScreen } from "./SearchScreen";

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  harness.focus.mockReset();
});

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted = null;
  }
});

describe("SearchScreen", () => {
  it("does not focus the query input without a focus request", async () => {
    await act(async () => {
      mounted = create(
        <SearchScreen
          focusRequestKey={0}
          query=""
          results={[]}
          onChangeQuery={vi.fn()}
          onOpenTask={vi.fn()}
        />
      );
    });

    expect(harness.focus).not.toHaveBeenCalled();
  });

  it("focuses the query input for each new focus request", async () => {
    const props = {
      focusRequestKey: 1,
      query: "existing query",
      results: [],
      onChangeQuery: vi.fn(),
      onOpenTask: vi.fn()
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SearchScreen {...props} />);
      mounted = renderer;
    });

    expect(harness.focus).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("TextInput").props.value).toBe("existing query");

    await act(async () => {
      renderer.update(<SearchScreen {...props} />);
    });
    expect(harness.focus).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<SearchScreen {...props} focusRequestKey={2} />);
    });
    expect(harness.focus).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("TextInput").props.value).toBe("existing query");
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- SearchScreen.test.tsx
```

Expected: FAIL because `SearchScreen` does not yet focus its `TextInput` and `harness.focus` has zero calls.

- [x] **Step 3: Implement request-driven focus in SearchScreen**

Update the React import and props in `apps/mobile/src/screens/SearchScreen.tsx`:

```tsx
import React, { useEffect, useRef } from "react";

interface SearchScreenProps {
  focusRequestKey: number;
  query: string;
  results: TaskSummary[];
  onChangeQuery(query: string): void;
  onOpenTask(taskId: string): void;
}
```

Destructure the new prop, create the input ref, and focus it from an effect:

```tsx
export function SearchScreen({
  focusRequestKey,
  query,
  results,
  onChangeQuery,
  onOpenTask
}: SearchScreenProps) {
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (focusRequestKey > 0) {
      inputRef.current?.focus();
    }
  }, [focusRequestKey]);
}
```

Keep the existing `return` block immediately after the new effect.

Attach the ref to the existing input without changing its query behavior:

```tsx
<TextInput
  ref={inputRef}
  autoCapitalize="none"
  onChangeText={onChangeQuery}
  placeholder="Search tasks"
  placeholderTextColor="#6A7E9D"
  style={styles.input}
  value={query}
/>
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- SearchScreen.test.tsx
```

Expected: PASS with no focus for request key `0`, one focus for initial positive request key `1`, no additional focus for an unchanged request key, and a second focus after the key advances.

### Task 2: Emit a focus request for every magnifier tap

**Files:**
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/App.tsx`

- [x] **Step 1: Write the failing app-wiring test**

Add this case to `describe("App component wiring", ...)` in `apps/mobile/src/App.component.test.tsx`:

```tsx
it("requests search input focus for every magnifier tap", async () => {
  const { model } = createModel("connected");
  const renderer = await mountModel(model);
  const toolbar = renderer.root.findByType("FloatingToolbar");

  await act(async () => {
    toolbar.props.onSelectUtilityAction("search");
  });

  expect(renderer.root.findByType("SearchScreen").props.focusRequestKey).toBe(1);

  await act(async () => {
    renderer.root
      .findByType("FloatingToolbar")
      .props.onSelectUtilityAction("search");
  });

  expect(renderer.root.findByType("SearchScreen").props.focusRequestKey).toBe(2);
});
```

- [x] **Step 2: Run the app-wiring test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- App.component.test.tsx
```

Expected: FAIL because the rendered `SearchScreen` has no `focusRequestKey` prop.

- [x] **Step 3: Implement the app-owned focus request key**

Add transient state alongside the other app-local UI state in `apps/mobile/src/App.tsx`:

```tsx
const [searchFocusRequestKey, setSearchFocusRequestKey] = useState(0);
```

Pass it into the Search screen:

```tsx
<SearchScreen
  focusRequestKey={searchFocusRequestKey}
  query={state.searchQuery}
  results={state.searchResults}
  onChangeQuery={(query) => {
    void controller.searchTasks(query);
  }}
  onOpenTask={(taskId) => controller.openTask(taskId)}
/>
```

Advance it before using the existing navigation action for every magnifier tap:

```tsx
onSelectUtilityAction={(action) => {
  if (action === "search") {
    setSearchFocusRequestKey((requestKey) => requestKey + 1);
    controller.showView("search");
    return;
  }

  controller.openComposer();
}}
```

- [x] **Step 4: Run both regression tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- SearchScreen.test.tsx App.component.test.tsx
```

Expected: PASS for both the input focus behavior and repeated toolbar-action wiring.

### Task 3: Verify the completed change

**Files:**
- Review: `apps/mobile/src/App.tsx`
- Review: `apps/mobile/src/App.component.test.tsx`
- Review: `apps/mobile/src/screens/SearchScreen.tsx`
- Review: `apps/mobile/src/screens/SearchScreen.test.tsx`
- Review: `docs/superpowers/specs/2026-07-17-mobile-search-input-focus-design.md`

- [x] **Step 1: Run the mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: PASS with no TypeScript diagnostics.

- [x] **Step 2: Run the full mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: PASS with no failing mobile tests.

- [x] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/src/App.tsx apps/mobile/src/App.component.test.tsx apps/mobile/src/screens/SearchScreen.tsx apps/mobile/src/screens/SearchScreen.test.tsx docs/superpowers/specs/2026-07-17-mobile-search-input-focus-design.md
```

Expected: no whitespace errors; only the approved search-focus implementation, tests, and design/plan documents are changed. These task-related changes are ready for the pipeline's commit stage.
