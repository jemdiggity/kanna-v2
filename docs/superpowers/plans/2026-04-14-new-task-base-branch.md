# New Task Base Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create a new task from a chosen Git base branch/ref, with lightweight branch selection, fuzzy search, and correct `base_ref`/worktree behavior.

**Architecture:** Add one pure TypeScript utility for branch ordering and fuzzy filtering, one pure store-side helper for resolving the selected base ref, and one new Tauri Git command to enumerate candidate branches. Keep the UI lightweight by extending `NewTaskModal.vue`, and fix the store/worktree path so `baseBranch` is always treated as a Git start point rather than as a Kanna worktree directory.

**Tech Stack:** Vue 3, Pinia store, Vitest, TypeScript, Tauri v2, Rust, git2, `fuzzyMatch.ts`

---

## File Structure

- `apps/desktop/src/utils/baseBranchPicker.ts`
  Responsibility: normalize, order, default, and fuzzy-filter base-branch candidates for the modal.
- `apps/desktop/src/utils/baseBranchPicker.test.ts`
  Responsibility: unit coverage for branch ordering and search behavior.
- `apps/desktop/src/components/NewTaskModal.vue`
  Responsibility: show the current base branch, open the lightweight branch picker, search branches, and emit `baseBranch` on submit.
- `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`
  Responsibility: verify modal rendering, picker search behavior, and submit payload.
- `apps/desktop/src/App.vue`
  Responsibility: load candidate branches when opening the modal and pass `baseBranch` into `store.createItem()`.
- `apps/desktop/src/stores/taskBaseBranch.ts`
  Responsibility: pure helpers for selecting the initial `base_ref` and worktree start point without relying on worktree-path assumptions.
- `apps/desktop/src/stores/taskBaseBranch.test.ts`
  Responsibility: unit coverage for `base_ref` selection and start-point behavior.
- `apps/desktop/src/stores/kanna.ts`
  Responsibility: consume the new helper functions in `createItem()` and `createWorktree()`.
- `apps/desktop/src-tauri/src/commands/git.rs`
  Responsibility: enumerate branch/ref candidates for the modal.
- `apps/desktop/src-tauri/src/lib.rs`
  Responsibility: register the new Tauri command.
- `apps/desktop/src/tauri-mock.ts`
  Responsibility: mock the new Tauri command for browser-mode tests.
- `apps/desktop/src/i18n/locales/en.json`
  Responsibility: labels and placeholder text for the base-branch picker.

### Task 1: Build Base-Branch Picker Utilities

**Files:**
- Create: `apps/desktop/src/utils/baseBranchPicker.ts`
- Create: `apps/desktop/src/utils/baseBranchPicker.test.ts`

- [ ] **Step 1: Write the failing utility tests**

Add `apps/desktop/src/utils/baseBranchPicker.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import {
  filterBaseBranchCandidates,
  getDefaultBaseBranch,
  orderBaseBranchCandidates,
} from "./baseBranchPicker";

describe("orderBaseBranchCandidates", () => {
  it("puts origin/default first, local default second, then the rest alphabetically", () => {
    expect(orderBaseBranchCandidates(
      ["feature/zeta", "main", "release/1.0", "origin/main", "feature/alpha"],
      "main",
    )).toEqual([
      "origin/main",
      "main",
      "feature/alpha",
      "feature/zeta",
      "release/1.0",
    ]);
  });

  it("deduplicates repeated branch names", () => {
    expect(orderBaseBranchCandidates(
      ["main", "origin/main", "main", "feature/a"],
      "main",
    )).toEqual(["origin/main", "main", "feature/a"]);
  });
});

describe("getDefaultBaseBranch", () => {
  it("prefers origin/default over local default", () => {
    expect(getDefaultBaseBranch(["main", "origin/main"], "main")).toBe("origin/main");
  });

  it("falls back to local default when origin/default is unavailable", () => {
    expect(getDefaultBaseBranch(["main", "feature/a"], "main")).toBe("main");
  });
});

describe("filterBaseBranchCandidates", () => {
  it("preserves canonical ordering for an empty query", () => {
    expect(filterBaseBranchCandidates(
      ["feature/zeta", "main", "origin/main", "feature/alpha"],
      "",
      "main",
    )).toEqual(["origin/main", "main", "feature/alpha", "feature/zeta"]);
  });

  it("filters and sorts matches with fuzzyMatch", () => {
    expect(filterBaseBranchCandidates(
      ["origin/main", "main", "feature/task-base-branch", "fix/base-branch-picker"],
      "tbb",
      "main",
    )).toEqual(["feature/task-base-branch"]);
  });
});
```

- [ ] **Step 2: Run the utility tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/utils/baseBranchPicker.test.ts`

Expected: FAIL with module-not-found for `./baseBranchPicker` or missing exported functions.

- [ ] **Step 3: Write the minimal utility implementation**

Create `apps/desktop/src/utils/baseBranchPicker.ts`:

```ts
import { fuzzyMatch } from "./fuzzyMatch";

function preferredRefs(defaultBranch: string): string[] {
  return [`origin/${defaultBranch}`, defaultBranch];
}

export function orderBaseBranchCandidates(
  candidates: string[],
  defaultBranch: string,
): string[] {
  const unique = [...new Set(candidates.filter((value) => value.trim().length > 0))];
  const preferred = preferredRefs(defaultBranch);
  const remaining = unique
    .filter((value) => !preferred.includes(value))
    .sort((a, b) => a.localeCompare(b));

  return [
    ...preferred.filter((value) => unique.includes(value)),
    ...remaining,
  ];
}

export function getDefaultBaseBranch(
  candidates: string[],
  defaultBranch: string,
): string {
  const ordered = orderBaseBranchCandidates(candidates, defaultBranch);
  return ordered[0] ?? defaultBranch;
}

export function filterBaseBranchCandidates(
  candidates: string[],
  query: string,
  defaultBranch: string,
): string[] {
  const ordered = orderBaseBranchCandidates(candidates, defaultBranch);
  const trimmed = query.trim();
  if (!trimmed) return ordered;

  return ordered
    .map((candidate) => ({
      candidate,
      match: fuzzyMatch(trimmed, candidate),
    }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      if (b.match!.score !== a.match!.score) return b.match!.score - a.match!.score;
      return a.candidate.localeCompare(b.candidate);
    })
    .map((entry) => entry.candidate);
}
```

- [ ] **Step 4: Run the utility tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/utils/baseBranchPicker.test.ts`

Expected: PASS with 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/baseBranchPicker.ts apps/desktop/src/utils/baseBranchPicker.test.ts
git commit -m "feat: add base branch picker utilities"
```

### Task 2: Add Git Branch Enumeration to Tauri and Browser Mock

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/git.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/tauri-mock.ts`
- Modify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

- [ ] **Step 1: Add a focused failing test expectation for the new command**

Extend `apps/desktop/src/components/__tests__/NewTaskModal.test.ts` by importing `invoke` from `../../invoke` and adding this assertion near the top of the file:

```ts
import { invoke } from "../../invoke";

it("exposes base-branch candidates through the invoke layer", async () => {
  await expect(invoke("git_list_base_branches", { repoPath: "/tmp/repo" })).resolves.toEqual([
    "origin/main",
    "main",
  ]);
});
```

This should fail first because the local `vi.mock("../../invoke", ...)` stub in the test file does not yet handle `git_list_base_branches`.

- [ ] **Step 2: Run the modal test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

Expected: FAIL with an unknown-command error for `git_list_base_branches`.

- [ ] **Step 3: Implement the new Tauri command and mock**

Update `apps/desktop/src-tauri/src/commands/git.rs`:

```rs
#[tauri::command]
pub fn git_list_base_branches(repo_path: String) -> Result<Vec<String>, String> {
    use std::collections::BTreeSet;

    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let default_branch = git_default_branch(repo_path.clone())?;
    let mut refs = BTreeSet::new();

    let branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?;

    for branch_result in branches {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            refs.insert(name.to_string());
        }
    }

    let origin_default_ref = format!("refs/remotes/origin/{}", default_branch);
    if repo.find_reference(&origin_default_ref).is_ok() {
        refs.insert(format!("origin/{}", default_branch));
    }

    Ok(refs.into_iter().collect())
}
```

Register the command in `apps/desktop/src-tauri/src/lib.rs` next to the other Git commands:

```rs
commands::git::git_list_base_branches,
```

Add a mock implementation in `apps/desktop/src/tauri-mock.ts`:

```ts
git_list_base_branches: () => ["origin/main", "main"],
```

Update the existing `vi.mock("../../invoke", ...)` block in `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`:

```ts
vi.mock("../../invoke", () => ({
  invoke: vi.fn(async (command: string, args?: { name?: string; repoPath?: string }) => {
    if (command === "git_list_base_branches") {
      return ["origin/main", "main"];
    }
    if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) {
      return true;
    }
    throw new Error("missing");
  }),
}));
```

- [ ] **Step 4: Run the modal test again to verify the mock path passes**

Run: `pnpm exec vitest run apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

Expected: PASS for the new invoke-layer assertion, with any remaining failures limited to modal UI work that has not been implemented yet.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/git.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/tauri-mock.ts apps/desktop/src/components/__tests__/NewTaskModal.test.ts
git commit -m "feat: expose base branch candidates to the new task modal"
```

### Task 3: Wire App Data Loading and Build the Modal Picker UI

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Modify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Read: `apps/desktop/src/components/AddRepoModal.vue`
- Read: `apps/desktop/src/utils/baseBranchPicker.ts`

- [ ] **Step 1: Write the failing modal tests for base-branch rendering, search, and submit**

Extend `apps/desktop/src/components/__tests__/NewTaskModal.test.ts` with these cases:

```ts
it("emits the selected base branch on submit", async () => {
  const wrapper = mount(NewTaskModal, {
    props: {
      defaultAgentProvider: "claude",
      workflows: ["default"],
      defaultWorkflow: "default",
      baseBranches: ["origin/main", "main", "feature/task-base-branch"],
      defaultBaseBranch: "origin/main",
      defaultBranchName: "main",
    },
    global: { mocks: { $t: (key: string) => key } },
  });

  await flushPromises();
  await wrapper.get("textarea").setValue("Ship branch picker");
  await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
  await wrapper.get('[data-testid="base-branch-option-feature/task-base-branch"]').trigger("click");
  await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

  expect(wrapper.emitted("submit")).toEqual([
    ["Ship branch picker", "claude", "default", "feature/task-base-branch"],
  ]);
});

it("filters branch options with fuzzy search", async () => {
  const wrapper = mount(NewTaskModal, {
    props: {
      baseBranches: ["origin/main", "main", "feature/task-base-branch", "fix/base-branch-picker"],
      defaultBaseBranch: "origin/main",
      defaultBranchName: "main",
    },
    global: { mocks: { $t: (key: string) => key } },
  });

  await flushPromises();
  await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
  await wrapper.get('[data-testid="base-branch-search"]').setValue("tbb");

  expect(wrapper.text()).toContain("feature/task-base-branch");
  expect(wrapper.text()).not.toContain("fix/base-branch-picker");
});

it("shows the selected base branch inline before the picker is opened", async () => {
  const wrapper = mount(NewTaskModal, {
    props: {
      baseBranches: ["origin/main", "main"],
      defaultBaseBranch: "origin/main",
      defaultBranchName: "main",
    },
    global: { mocks: { $t: (key: string) => key } },
  });

  await flushPromises();

  expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("origin/main");
});
```

- [ ] **Step 2: Run the modal test file to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

Expected: FAIL because `NewTaskModal.vue` does not yet accept `baseBranches`/`defaultBaseBranch`, does not render the picker, and still emits only three submit arguments.

- [ ] **Step 3: Implement App-side branch loading**

Update `apps/desktop/src/App.vue` near the existing modal state:

```ts
const availableBaseBranches = ref<string[]>([]);
const defaultBaseBranchName = ref<string>();
const repoDefaultBranchName = ref<string>();
```

Extend `openNewTaskModal()` so it loads both the repo default branch and branch candidates:

```ts
const defaultBranch = await invoke<string>("git_default_branch", { repoPath }).catch(() => "main");
repoDefaultBranchName.value = defaultBranch;

availableBaseBranches.value = await invoke<string[]>("git_list_base_branches", { repoPath })
  .catch(() => [`origin/${defaultBranch}`, defaultBranch]);
defaultBaseBranchName.value = availableBaseBranches.value[0] ?? defaultBranch;
```

Reset both refs in the no-repo path:

```ts
availableBaseBranches.value = [];
defaultBaseBranchName.value = undefined;
repoDefaultBranchName.value = undefined;
```

Update the submit handler signature:

```ts
async function handleNewTaskSubmit(
  prompt: string,
  agentProvider: AgentProvider,
  workflowName?: string,
  baseBranch?: string,
) {
  // ...
  await store.createItem(store.selectedRepoId, repo.path, prompt, "pty", {
    agentProvider,
    workflowName,
    baseBranch,
  });
}
```

Pass the new props into the modal:

```vue
<NewTaskModal
  v-if="showNewTaskModal"
  :default-agent-provider="preferences.defaultAgentProvider"
  :workflows="availableWorkflows"
  :default-workflow="defaultWorkflowName"
  :base-branches="availableBaseBranches"
  :default-base-branch="defaultBaseBranchName"
  :default-branch-name="repoDefaultBranchName"
  @submit="(prompt, agentProvider, workflowName, baseBranch) => handleNewTaskSubmit(prompt, agentProvider, workflowName, baseBranch)"
  @cancel="showNewTaskModal = false"
/>
```

- [ ] **Step 4: Implement the lightweight picker UI in `NewTaskModal.vue`**

Add props and emits:

```ts
import { computed, onMounted, ref, watch } from "vue";
import { filterBaseBranchCandidates, getDefaultBaseBranch } from "../utils/baseBranchPicker";

const props = defineProps<{
  defaultAgentProvider?: AgentProvider;
  workflows?: string[];
  defaultWorkflow?: string;
  baseBranches?: string[];
  defaultBaseBranch?: string;
  defaultBranchName?: string;
}>();

const emit = defineEmits<{
  submit: [prompt: string, agentProvider: AgentProvider, workflowName: string, baseBranch: string];
  cancel: [];
}>();
```

Add branch-picker state:

```ts
const showBaseBranchPicker = ref(false);
const baseBranchQuery = ref("");
const selectedBaseBranch = ref(
  props.defaultBaseBranch
    ?? getDefaultBaseBranch(props.baseBranches ?? [], "main"),
);

watch(
  () => [props.baseBranches, props.defaultBaseBranch] as const,
  ([branches, defaultBaseBranch]) => {
    selectedBaseBranch.value = defaultBaseBranch
      ?? getDefaultBaseBranch(branches ?? [], "main");
  },
  { immediate: true },
);

const visibleBaseBranches = computed(() =>
  filterBaseBranchCandidates(
    props.baseBranches ?? [],
    baseBranchQuery.value,
    props.defaultBranchName ?? "main",
  ),
);
```

Update submit:

```ts
emit("submit", text, agentProvider.value, selectedWorkflow.value, selectedBaseBranch.value);
```

Add the new row in the template using the import-repo dialog’s lightweight link style:

```vue
<div class="workflow-row">
  <label class="workflow-label">{{ $t("tasks.baseBranch") }}</label>
  <div class="base-branch-row">
    <span class="base-branch-value" data-testid="base-branch-value">{{ selectedBaseBranch }}</span>
    <button
      type="button"
      class="change-link"
      data-testid="base-branch-toggle"
      @mousedown.prevent
      @click="showBaseBranchPicker = !showBaseBranchPicker"
    >
      {{ $t("addRepo.change") }}
    </button>
  </div>
</div>

<div v-if="showBaseBranchPicker" class="base-branch-picker">
  <input
    v-model="baseBranchQuery"
    v-bind="macOsTextInputAttrs"
    class="text-input"
    type="text"
    :placeholder="$t('tasks.baseBranchSearchPlaceholder')"
    data-testid="base-branch-search"
  />
  <button
    v-for="branch in visibleBaseBranches"
    :key="branch"
    type="button"
    class="base-branch-option"
    :class="{ selected: branch === selectedBaseBranch }"
    :data-testid="`base-branch-option-${branch}`"
    @mousedown.prevent
    @click="selectedBaseBranch = branch"
  >
    {{ branch }}
  </button>
</div>
```

Add the new strings to `apps/desktop/src/i18n/locales/en.json`:

```json
"baseBranch": "Base branch",
"baseBranchSearchPlaceholder": "Search branches..."
```

- [ ] **Step 5: Run the modal tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

Expected: PASS for the existing provider-switching coverage plus the new base-branch tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/components/__tests__/NewTaskModal.test.ts apps/desktop/src/i18n/locales/en.json
git commit -m "feat: add base branch picker to the new task modal"
```

### Task 4: Refactor Store Base-Ref and Worktree Start-Point Logic

**Files:**
- Create: `apps/desktop/src/stores/taskBaseBranch.ts`
- Create: `apps/desktop/src/stores/taskBaseBranch.test.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Write the failing store-helper tests**

Create `apps/desktop/src/stores/taskBaseBranch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getCreateWorktreeStartPoint,
  resolveInitialBaseRef,
} from "./taskBaseBranch";

describe("resolveInitialBaseRef", () => {
  it("uses the selected base branch when present", () => {
    expect(resolveInitialBaseRef({
      selectedBaseBranch: "feature/task-base-branch",
      defaultBranch: "main",
    })).toBe("feature/task-base-branch");
  });

  it("prefers origin/default for fallback base_ref", () => {
    expect(resolveInitialBaseRef({
      availableBaseBranches: ["origin/main", "main"],
      defaultBranch: "main",
    })).toBe("origin/main");
  });
});

describe("getCreateWorktreeStartPoint", () => {
  it("returns the explicit base branch as the worktree start point", () => {
    expect(getCreateWorktreeStartPoint("feature/task-base-branch")).toBe("feature/task-base-branch");
  });

  it("does not invent a .kanna-worktrees path for arbitrary branches", () => {
    expect(getCreateWorktreeStartPoint("release/1.2")).not.toContain(".kanna-worktrees");
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/src/stores/taskBaseBranch.test.ts`

Expected: FAIL with module-not-found for `./taskBaseBranch`.

- [ ] **Step 3: Implement the pure helper and use it in `kanna.ts`**

Create `apps/desktop/src/stores/taskBaseBranch.ts`:

```ts
export interface ResolveInitialBaseRefOptions {
  selectedBaseBranch?: string;
  availableBaseBranches?: string[];
  defaultBranch: string;
}

export function resolveInitialBaseRef(
  options: ResolveInitialBaseRefOptions,
): string {
  if (options.selectedBaseBranch) return options.selectedBaseBranch;

  const originDefault = `origin/${options.defaultBranch}`;
  if (options.availableBaseBranches?.includes(originDefault)) return originDefault;
  return options.defaultBranch;
}

export function getCreateWorktreeStartPoint(baseBranch?: string): string | null {
  return baseBranch ?? null;
}
```

Refactor `createItem()` in `apps/desktop/src/stores/kanna.ts`:

```ts
import { getCreateWorktreeStartPoint, resolveInitialBaseRef } from "./taskBaseBranch";
```

Replace the `base_ref` block with:

```ts
const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
const availableBaseBranches = await invoke<string[]>("git_list_base_branches", { repoPath })
  .catch(() => [`origin/${defaultBranch}`, defaultBranch]);
baseRef = resolveInitialBaseRef({
  selectedBaseBranch: opts?.baseBranch,
  availableBaseBranches,
  defaultBranch,
});
```

Refactor `createWorktree()` so it always uses the repo root and an explicit start point:

```ts
async function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  baseBranch?: string,
): Promise<WorktreeBootstrapResult> {
  const visibleBootstrapSteps: string[] = [];
  let startPoint = getCreateWorktreeStartPoint(baseBranch);
  let renderedStartPoint = startPoint ?? "HEAD";

  if (!startPoint) {
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
    renderedStartPoint = defaultBranch;
    visibleBootstrapSteps.push(`git fetch origin ${defaultBranch}`);
    await invoke("git_fetch", { repoPath, branch: defaultBranch });
    startPoint = `origin/${defaultBranch}`;
    renderedStartPoint = startPoint;
  }

  await invoke("git_worktree_add", {
    repoPath,
    branch,
    path: worktreePath,
    startPoint,
  });

  visibleBootstrapSteps.push(
    `git worktree add -b ${branch} '${worktreePath.replace(/'/g, `'\\''`)}' ${renderedStartPoint}`,
  );

  return { visibleBootstrapSteps };
}
```

This is the key behavioral fix: no `worktreeAddCwd`, no `${repoPath}/.kanna-worktrees/${baseBranch}` assumption, and no special `HEAD` path for stage-advanced tasks.

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `pnpm exec vitest run apps/desktop/src/stores/taskBaseBranch.test.ts`

Expected: PASS with 4 tests passing.

- [ ] **Step 5: Run the targeted modal and helper tests together**

Run: `pnpm exec vitest run apps/desktop/src/utils/baseBranchPicker.test.ts apps/desktop/src/components/__tests__/NewTaskModal.test.ts apps/desktop/src/stores/taskBaseBranch.test.ts`

Expected: PASS with all three files green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/taskBaseBranch.ts apps/desktop/src/stores/taskBaseBranch.test.ts apps/desktop/src/stores/kanna.ts
git commit -m "fix: treat task base branches as git start points"
```

### Task 5: Final Verification and Cleanup

**Files:**
- Modify: any files touched above if verification exposes issues

- [ ] **Step 1: Run the full targeted frontend verification**

Run:

```bash
pnpm exec vitest run \
  apps/desktop/src/utils/baseBranchPicker.test.ts \
  apps/desktop/src/components/__tests__/NewTaskModal.test.ts \
  apps/desktop/src/stores/taskBaseBranch.test.ts
```

Expected: PASS across all targeted tests.

- [ ] **Step 2: Run the TypeScript check**

Run: `pnpm exec tsc --noEmit`

Expected: PASS with no type errors.

- [ ] **Step 3: Run Rust formatting and linting for the new command**

Run:

```bash
cd apps/desktop/src-tauri
cargo fmt --all
cargo clippy -- -D warnings
```

Expected: PASS with no formatting changes left uncommitted and no clippy warnings.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --stat
git diff -- apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/App.vue apps/desktop/src/stores/kanna.ts apps/desktop/src-tauri/src/commands/git.rs
```

Expected: the diff shows only the new branch-picker flow, the new helpers, and the command wiring. There should be no unrelated modal restyling and no leftover debug logging.

- [ ] **Step 5: Commit the final verification fixes if needed**

```bash
git add apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/App.vue apps/desktop/src/stores/kanna.ts apps/desktop/src-tauri/src/commands/git.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/tauri-mock.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/utils/baseBranchPicker.ts apps/desktop/src/utils/baseBranchPicker.test.ts apps/desktop/src/stores/taskBaseBranch.ts apps/desktop/src/stores/taskBaseBranch.test.ts apps/desktop/src/components/__tests__/NewTaskModal.test.ts
git commit -m "test: verify new task base branch flow"
```

## Self-Review

### Spec coverage

- Branch enumeration is covered in Task 2.
- Lightweight modal chooser and inline selected branch are covered in Task 3.
- Fuzzy search reuse is covered in Task 1 and consumed in Task 3.
- `base_ref` alignment and worktree start-point fix are covered in Task 4.
- Verification commands from the repo conventions are covered in Task 5.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every step names exact files and explicit commands.

### Type consistency

- Shared names are consistent across tasks:
  - `git_list_base_branches`
  - `baseBranches`
  - `defaultBaseBranch`
  - `resolveInitialBaseRef`
  - `getCreateWorktreeStartPoint`
