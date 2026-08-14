# Markdown Preview Mode Preference Implementation Plan

> **Snapshot reload concurrency amendment:** A settings PUT broadcasts KSP state changes, so snapshot reloads may overlap. The shared `reloadSnapshot` path must use latest-started semantics: only the current run applies the base snapshot/settings, records and propagates errors, or clears pending state.
>
> Additional expected files and tasks:
>
> - `apps/desktop/src/stores/queries.ts` — assign each reload a run ID; ignore superseded successes before and after repo-config loading; ignore superseded failures; gate pending cleanup to the current run.
> - `apps/desktop/src/stores/kanna.querySnapshot.test.ts` — prove a newest non-default raw snapshot applies before and survives an older rendered response; settle stale success and failure while the newer run remains pending; block an older run in repository-config loading to cover the second ownership guard; and characterize current-failure rejection, error, and pending behavior.
>
> No schema or server changes are required for this amendment.

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Markdown files rendered by default, then persist the user's latest raw/rendered choice globally across tasks, repositories, windows, and app restarts.

**Architecture:** Define and normalize a typed `markdownPreviewMode` desktop setting in the store snapshot path, defaulting to `rendered`. Replace task-scoped Markdown mode recall with that global store value, persist modal toggles through a single-flight queue that coalesces pending choices to the latest mode, and retain `FilePreviewModal`'s Markdown extension guard so non-Markdown files remain raw.

**Tech Stack:** Vue 3 Composition API, Pinia, TypeScript, Vitest, Vue Test Utils, existing SQLite-backed desktop settings API

---

## Execution Constraint

This Kanna stage explicitly leaves commits to the later workflow stage. Run every red/green checkpoint below, but do not create local commits while executing this plan.

## File Structure

- Create `apps/desktop/src/stores/markdownPreviewMode.ts`: own the setting key, mode type, rendered default, and persisted-value normalizer.
- Modify `apps/desktop/src/stores/state.ts`: add the typed reactive setting to `StoreState` and initialize it.
- Modify `apps/desktop/src/stores/snapshotSettings.ts`: hydrate the setting from desktop snapshots.
- Modify `apps/desktop/src/stores/kanna.ts`: expose the setting through the Pinia store.
- Modify `apps/desktop/src/composables/useAppModals.ts`: consume the global mode and serialize save-and-reload transactions while coalescing pending toggles.
- Modify `apps/desktop/src/components/FilePreviewModal.vue`: make rendered mode the standalone prop default while preserving the Markdown-file guard.
- Modify `apps/desktop/src/stores/init.test.ts`: cover missing, valid, and invalid persisted modes.
- Modify `apps/desktop/src/composables/useAppModals.test.ts`: cover global cross-task reuse, reverse-completion rapid toggles, and persistence failure continuation.
- Modify `apps/desktop/src/App.test.ts`: cover app-level wiring from modal input through the store persistence call.
- Modify `apps/desktop/src/components/__tests__/FilePreviewModal.test.ts`: cover the rendered Markdown default and non-Markdown guard.

### Task 1: Define and Hydrate the Global Setting

**Files:**
- Create: `apps/desktop/src/stores/markdownPreviewMode.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/snapshotSettings.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/init.test.ts`

- [ ] **Step 1: Write the failing snapshot-setting test**

Add this suite to `apps/desktop/src/stores/init.test.ts`:

~~~ts
describe("Markdown preview mode settings", () => {
  it.each([
    { settings: {}, expected: "rendered" },
    { settings: { markdownPreviewMode: "raw" }, expected: "raw" },
    { settings: { markdownPreviewMode: "rendered" }, expected: "rendered" },
    { settings: { markdownPreviewMode: "invalid" }, expected: "rendered" },
  ])("normalizes $settings to $expected", ({ settings, expected }) => {
    const state = createStoreState();

    applySnapshotSettingsToState(state, settings);

    const modeState = Reflect.get(state, "markdownPreviewMode") as
      | { value?: string }
      | undefined;
    expect(modeState?.value).toBe(expected);
  });
});
~~~

- [ ] **Step 2: Run the test and verify the red state**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/stores/init.test.ts -t "Markdown preview mode settings"
~~~

Expected: FAIL with an assertion equivalent to `expected undefined to be "rendered"` because the store setting does not exist.

- [ ] **Step 3: Create the typed setting boundary**

Create `apps/desktop/src/stores/markdownPreviewMode.ts`:

~~~ts
export type MarkdownPreviewMode = "raw" | "rendered";

export const MARKDOWN_PREVIEW_MODE_SETTING_KEY = "markdownPreviewMode";
export const DEFAULT_MARKDOWN_PREVIEW_MODE: MarkdownPreviewMode = "rendered";

export function normalizeMarkdownPreviewMode(
  value: string | null | undefined,
): MarkdownPreviewMode {
  return value === "raw" || value === "rendered"
    ? value
    : DEFAULT_MARKDOWN_PREVIEW_MODE;
}
~~~

- [ ] **Step 4: Add the setting to store state**

In `apps/desktop/src/stores/state.ts`, add the import:

~~~ts
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  type MarkdownPreviewMode,
} from "./markdownPreviewMode";
~~~

Add this field to `StoreState` beside the other preference refs:

~~~ts
markdownPreviewMode: Ref<MarkdownPreviewMode>;
~~~

Initialize it in `createStoreState()`:

~~~ts
const markdownPreviewMode = ref<MarkdownPreviewMode>(DEFAULT_MARKDOWN_PREVIEW_MODE);
~~~

Return it with the other state values:

~~~ts
return {
  // existing fields
  agentMessageAppearance,
  markdownPreviewMode,
  lastHiddenRepoId,
  // remaining fields
};
~~~

- [ ] **Step 5: Hydrate and expose the setting**

In `apps/desktop/src/stores/snapshotSettings.ts`, import the normalizer:

~~~ts
import { normalizeMarkdownPreviewMode } from "./markdownPreviewMode";
~~~

Include `"markdownPreviewMode"` in the `Pick<StoreState, ...>` union, then assign it after the existing appearance setting:

~~~ts
state.markdownPreviewMode.value = normalizeMarkdownPreviewMode(
  settings.markdownPreviewMode,
);
~~~

In `apps/desktop/src/stores/kanna.ts`, expose the ref beside the other preference state:

~~~ts
return {
  // existing fields
  agentMessageAppearance: state.agentMessageAppearance,
  markdownPreviewMode: state.markdownPreviewMode,
  pendingSetupIds: state.pendingSetupIds,
  // remaining fields
};
~~~

- [ ] **Step 6: Run the focused test and verify green**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/stores/init.test.ts -t "Markdown preview mode settings"
~~~

Expected: PASS for all four cases.

- [ ] **Step 7: Refactor the test back to typed access**

Replace the `Reflect.get` assertion with:

~~~ts
expect(state.markdownPreviewMode.value).toBe(expected);
~~~

Run the same command again. Expected: PASS.

### Task 2: Use and Persist One Global Choice

**Files:**
- Modify: `apps/desktop/src/composables/useAppModals.ts`
- Modify: `apps/desktop/src/composables/useAppModals.test.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Add a reusable modal test harness**

Update the Vue import in `apps/desktop/src/composables/useAppModals.test.ts`:

~~~ts
import { defineComponent, h, nextTick, reactive } from "vue";
~~~

Import the mode type:

~~~ts
import type { MarkdownPreviewMode } from "../stores/markdownPreviewMode";
~~~

Add this helper above the `describe("useAppModals", ...)` block:

~~~ts
function mountMarkdownModalHarness(options: {
  markdownPreviewMode?: MarkdownPreviewMode;
  savePreference?: (key: string, value: string) => Promise<void>;
} = {}) {
  const savePreference = vi.fn(
    options.savePreference ?? (async () => {}),
  );
  const store = reactive({
    selectedRepo: {
      id: "repo-1",
      path: "/repo",
    },
    currentItem: {
      id: "task-a",
      branch: "task-a",
    },
    markdownPreviewMode: options.markdownPreviewMode ?? "rendered",
    savePreference,
  });
  const TestHarness = defineComponent({
    setup() {
      const modals = useAppModals({
        isMobile: false,
        store: store as unknown as Parameters<typeof useAppModals>[0]["store"],
        windowWorkspace: {
          bootstrap: { windowId: "main" },
          loadSnapshot: vi.fn(),
          persistSidebarWidth: vi.fn(),
        } as unknown as Parameters<typeof useAppModals>[0]["windowWorkspace"],
      });
      return { modals };
    },
    render() {
      return h("div");
    },
  });
  const wrapper = mount(TestHarness);

  return {
    modals: wrapper.vm.modals,
    savePreference,
    store,
    wrapper,
  };
}
~~~

- [ ] **Step 2: Write the failing global-choice test**

Add:

~~~ts
it("uses and persists one Markdown mode across task preview flows", async () => {
  const { modals, savePreference, store, wrapper } =
    mountMarkdownModalHarness();

  modals.openFilePreview("README.md", undefined, false);
  expect(modals.currentPreviewMarkdownMode.value).toBe("rendered");

  modals.updateCurrentPreviewMarkdownMode("raw");
  expect(store.markdownPreviewMode).toBe("raw");
  expect(savePreference).toHaveBeenCalledWith(
    "markdownPreviewMode",
    "raw",
  );

  store.currentItem = {
    id: "task-b",
    branch: "task-b",
  };
  await nextTick();
  modals.openFilePreview("docs/guide.md", undefined, false);

  expect(modals.currentPreviewMarkdownMode.value).toBe("raw");

  wrapper.unmount();
});
~~~

Add a deferred-based test named `"keeps the latest Markdown mode when saves resolve out of order"`. Trigger `raw` and then `rendered`, release the rendered save before the raw save, and assert that calls remain ordered `raw` then `rendered`, the final store mode is `rendered`, and no more than one save is active at once. The save doubles should simulate snapshot reload by assigning their saved value back to the store when they complete.

- [ ] **Step 3: Update the app-level expectation before implementation**

In the `store` mock in `apps/desktop/src/App.test.ts`, add:

~~~ts
markdownPreviewMode: "rendered" as "raw" | "rendered",
~~~

In `beforeEach`, reset both the preference and its mock:

~~~ts
store.markdownPreviewMode = "rendered";
store.savePreference.mockClear();
~~~

Replace the existing `"remembers markdown render mode when reopening a preview window"` test with:

~~~ts
it("opens Markdown rendered and persists a raw-mode choice", async () => {
  const MarkdownFilePickerModalTestStub = defineComponent({
    name: "FilePickerModal",
    emits: ["select"],
    template: `
      <div data-testid="file-picker-modal">
        <button data-testid="file-picker-select" @click="$emit('select', 'docs/example.md')">select</button>
      </div>
    `,
  });

  const MarkdownModeFilePreviewModalTestStub = defineComponent({
    name: "FilePreviewModal",
    props: {
        initialMarkdownMode: {
          type: String,
          default: "raw",
        },
    },
    emits: ["close", "update-markdown-mode"],
    setup(_props, { emit, expose }) {
      function dismiss() {
        emit("close");
        return true;
      }

      expose({ dismiss, zIndex: 1000, bringToFront: vi.fn() });

      return { emit };
    },
    template: `
      <div data-testid="file-preview-modal" :data-mode="initialMarkdownMode">
        <button data-testid="toggle-markdown-raw" @click="emit('update-markdown-mode', 'raw')">raw</button>
      </div>
    `,
  });

  const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
    FilePickerModal: MarkdownFilePickerModalTestStub,
    FilePreviewModal: MarkdownModeFilePreviewModalTestStub,
  });

  capturedKeyboardActions?.openFile();
  await flushPromises();
  await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
  await flushPromises();

  expect(
    wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode"),
  ).toBe("rendered");

  await wrapper.get('[data-testid="toggle-markdown-raw"]').trigger("click");
  await flushPromises();

  expect(store.markdownPreviewMode).toBe("raw");
  expect(store.savePreference).toHaveBeenCalledWith(
    "markdownPreviewMode",
    "raw",
  );

  wrapper.unmount();
});
~~~

- [ ] **Step 4: Run both tests and verify the red state**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/composables/useAppModals.test.ts src/App.test.ts -t "Markdown|markdown"
~~~

Expected: FAIL because `useAppModals` still defaults each task/repository flow to raw and launches rapid saves concurrently; reverse completion leaves the store on raw.

- [ ] **Step 5: Replace task-scoped mode state with the global setting**

In `apps/desktop/src/composables/useAppModals.ts`, import:

~~~ts
import {
  MARKDOWN_PREVIEW_MODE_SETTING_KEY,
  type MarkdownPreviewMode,
} from "../stores/markdownPreviewMode";
~~~

Remove `markdownMode` from `FilePreviewRecallState`:

~~~ts
interface FilePreviewRecallState {
  filePath: string;
  initialLine?: number;
}
~~~

Keep `rememberCurrentPreview` focused on file and line recall:

~~~ts
function rememberCurrentPreview(
  filePath: string,
  initialLine: number | undefined,
) {
  const key = buildCurrentFileFlowKey();
  if (!key) return;
  filePreviewRecallStates[key] = {
    filePath,
    initialLine,
  };
}
~~~

Replace the current computed value and update function with a single-flight persistence drain:

~~~ts
const currentPreviewMarkdownMode = computed<MarkdownPreviewMode>(
  () => store.markdownPreviewMode,
);

let markdownPreviewModeSaveInFlight = false;
let pendingMarkdownPreviewMode: MarkdownPreviewMode | undefined;

async function drainMarkdownPreviewModeSaves() {
  if (markdownPreviewModeSaveInFlight) return;
  markdownPreviewModeSaveInFlight = true;

  try {
    while (pendingMarkdownPreviewMode !== undefined) {
      const mode = pendingMarkdownPreviewMode;
      pendingMarkdownPreviewMode = undefined;

      try {
        await store.savePreference(MARKDOWN_PREVIEW_MODE_SETTING_KEY, mode);
      } catch (error: unknown) {
        console.error("[App] failed to persist Markdown preview mode:", error);
      }

      if (pendingMarkdownPreviewMode !== undefined) {
        store.markdownPreviewMode = pendingMarkdownPreviewMode;
      }
    }
  } finally {
    markdownPreviewModeSaveInFlight = false;
  }
}

function updateCurrentPreviewMarkdownMode(mode: MarkdownPreviewMode) {
  store.markdownPreviewMode = mode;
  pendingMarkdownPreviewMode = mode;
  void drainMarkdownPreviewModeSaves();
}
~~~

- [ ] **Step 6: Run both tests and verify green**

Run the command from Step 4 again.

Expected: PASS for app wiring, cross-task persistence, and reverse-completion rapid toggles. At most one save is active, pending choices coalesce to the latest mode, and the latest optimistic value is reapplied after an older snapshot reload.

- [ ] **Step 7: Add persistence-failure continuation coverage**

Add a test that queues `raw` and then `rendered`, rejects the first save, and succeeds the second. Wait for both calls, then assert that the final store mode is `rendered`, calls remain ordered, and the earlier failure is logged. Create the console spy before entering `try`, mount inside the protected region, and restore the spy plus unmount the optional wrapper in `finally`.

- [ ] **Step 8: Re-run the composable and app tests**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/composables/useAppModals.test.ts src/App.test.ts -t "Markdown|markdown|persistence|rapid|latest"
~~~

Expected: PASS with no overlapping saves or unhandled promise rejection. A failed earlier save is logged and does not block the latest queued save.

### Task 3: Make the Preview Component Default Rendered

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`
- Test: `apps/desktop/src/components/__tests__/FilePreviewModal.test.ts`

- [ ] **Step 1: Write the failing rendered-default test**

Add:

~~~ts
it("renders Markdown by default when no mode is provided", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "read_text_file") {
      return "# Preview heading\n";
    }
    if (command === "run_script") {
      return "";
    }
    throw new Error(`unexpected invoke: ${command}`);
  });

  const wrapper = mount(FilePreviewModal, {
    props: {
      filePath: "README.md",
      worktreePath: "/repo",
    },
    attachTo: document.body,
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });

  await flushPromises();
  await flushPromises();
  await flushPromises();

  expect(wrapper.get(".preview-content").classes()).toContain(
    "markdown-rendered",
  );
  expect(wrapper.get(".mode-badge").text()).toBe("filePreview.rendered");

  wrapper.unmount();
});
~~~

- [ ] **Step 2: Run the test and verify the red state**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/components/__tests__/FilePreviewModal.test.ts -t "renders Markdown by default"
~~~

Expected: FAIL because an omitted `initialMarkdownMode` currently initializes raw mode.

- [ ] **Step 3: Add the rendered prop default**

In `apps/desktop/src/components/FilePreviewModal.vue`, import:

~~~ts
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  type MarkdownPreviewMode,
} from "../stores/markdownPreviewMode";
~~~

Replace the props declaration with:

~~~ts
const props = withDefaults(defineProps<{
  filePath: string;
  worktreePath: string;
  ideCommand?: string;
  maximized?: boolean;
  initialLine?: number;
  initialMarkdownMode?: MarkdownPreviewMode;
}>(), {
  initialMarkdownMode: DEFAULT_MARKDOWN_PREVIEW_MODE,
});
~~~

Update the event type to share the mode alias:

~~~ts
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update-markdown-mode", mode: MarkdownPreviewMode): void;
}>();
~~~

Leave the existing initialization guard intact:

~~~ts
const renderMarkdown = ref(
  props.initialMarkdownMode === "rendered" && isMarkdownFile.value,
);
~~~

- [ ] **Step 4: Run the test and verify green**

Run the command from Step 2 again.

Expected: PASS and the rendered heading is present.

- [ ] **Step 5: Add a non-Markdown characterization test**

Add:

~~~ts
it("keeps non-Markdown files raw when rendered mode is requested", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "read_text_file") {
      return "const answer = 42;\n";
    }
    if (command === "run_script") {
      return "";
    }
    throw new Error(`unexpected invoke: ${command}`);
  });

  const wrapper = mount(FilePreviewModal, {
    props: {
      filePath: "example.ts",
      worktreePath: "/repo",
      initialMarkdownMode: "rendered",
    },
    attachTo: document.body,
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });

  await flushPromises();
  await flushPromises();

  expect(wrapper.get(".preview-content").classes()).not.toContain(
    "markdown-rendered",
  );
  expect(wrapper.find(".mode-badge").exists()).toBe(false);
  expect(codeToHtmlMock).toHaveBeenCalled();

  wrapper.unmount();
});
~~~

- [ ] **Step 6: Run all preview component tests**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/components/__tests__/FilePreviewModal.test.ts
~~~

Expected: PASS for the new default and all existing highlighting, search, and close behavior.

### Task 4: Verify the Complete Change

**Files:**
- Verify: all implementation and test files above
- Verify: `docs/superpowers/specs/2026-07-11-markdown-preview-mode-preference-design.md`

- [ ] **Step 1: Run the complete focused suite**

Run:

~~~bash
pnpm --dir apps/desktop test -- src/stores/init.test.ts src/composables/useAppModals.test.ts src/components/__tests__/FilePreviewModal.test.ts src/App.test.ts
~~~

Expected: PASS with zero failed tests and no unhandled rejections.

- [ ] **Step 2: Run desktop type checking**

Run:

~~~bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
~~~

Expected: exit code 0 with no type errors.

- [ ] **Step 3: Run the full desktop unit suite**

Run:

~~~bash
pnpm --dir apps/desktop test
~~~

Expected: exit code 0 with zero failed tests.

- [ ] **Step 4: Review formatting and scope**

Run:

~~~bash
git diff --check
git status --short
git diff -- apps/desktop/src/stores/markdownPreviewMode.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/snapshotSettings.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/composables/useAppModals.ts apps/desktop/src/components/FilePreviewModal.vue apps/desktop/src/stores/init.test.ts apps/desktop/src/composables/useAppModals.test.ts apps/desktop/src/App.test.ts apps/desktop/src/components/__tests__/FilePreviewModal.test.ts
~~~

Expected: no whitespace errors; changes are limited to the approved global Markdown preview preference, its tests, and the two planning documents. Do not commit in this stage.
