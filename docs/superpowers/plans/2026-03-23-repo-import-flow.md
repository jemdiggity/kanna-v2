# Repo Import Flow Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ImportRepoModal with a tabbed AddRepoModal supporting create new, import local, and clone from GitHub.

**Architecture:** New AddRepoModal.vue component with two tabs, backed by `parseRepoInput()` utility for smart input detection. Two new Rust commands (`git_clone`, `git_init`) and one new FS command (`ensure_directory`). Store gets `createRepo()` and `cloneAndImportRepo()` methods. Keyboard shortcuts updated: ⌘I for create, ⇧⌘I for import/clone.

**Tech Stack:** Vue 3, TypeScript, Rust (git2 + std::process::Command), Tauri v2, SQLite

**Spec:** `docs/superpowers/specs/2026-03-23-repo-import-flow-design.md`

---

### Task 1: Add `parseRepoInput` utility

**Files:**
- Create: `apps/desktop/src/utils/parseRepoInput.ts`
- Create: `apps/desktop/src/utils/parseRepoInput.test.ts`

- [ ] **Step 1: Write tests for parseRepoInput**

```typescript
// apps/desktop/src/utils/parseRepoInput.test.ts
import { describe, it, expect } from "vitest";
import { parseRepoInput } from "./parseRepoInput";

describe("parseRepoInput", () => {
  it("detects HTTPS GitHub URL", () => {
    const r = parseRepoInput("https://github.com/owner/repo");
    expect(r).toEqual({ type: "clone", owner: "owner", repo: "repo", cloneUrl: "https://github.com/owner/repo.git" });
  });

  it("detects HTTPS URL with .git suffix", () => {
    const r = parseRepoInput("https://github.com/owner/repo.git");
    expect(r).toEqual({ type: "clone", owner: "owner", repo: "repo", cloneUrl: "https://github.com/owner/repo.git" });
  });

  it("detects SSH URL", () => {
    const r = parseRepoInput("git@github.com:owner/repo.git");
    expect(r).toEqual({ type: "clone", owner: "owner", repo: "repo", cloneUrl: "git@github.com:owner/repo.git" });
  });

  it("detects owner/repo shorthand", () => {
    const r = parseRepoInput("jemdiggity/kanna-v2");
    expect(r).toEqual({ type: "clone", owner: "jemdiggity", repo: "kanna-v2", cloneUrl: "https://github.com/jemdiggity/kanna-v2.git" });
  });

  it("detects gh repo clone command", () => {
    const r = parseRepoInput("gh repo clone owner/repo");
    expect(r).toEqual({ type: "clone", owner: "owner", repo: "repo", cloneUrl: "https://github.com/owner/repo.git" });
  });

  it("detects absolute local path", () => {
    const r = parseRepoInput("/Users/me/code/project");
    expect(r).toEqual({ type: "local", localPath: "/Users/me/code/project" });
  });

  it("detects tilde path", () => {
    const r = parseRepoInput("~/code/project");
    expect(r).toEqual({ type: "local", localPath: "~/code/project" });
  });

  it("returns unknown for empty string", () => {
    expect(parseRepoInput("")).toEqual({ type: "unknown" });
  });

  it("returns unknown for random text", () => {
    expect(parseRepoInput("hello world")).toEqual({ type: "unknown" });
  });

  it("returns unknown for triple-segment path without leading slash", () => {
    expect(parseRepoInput("a/b/c")).toEqual({ type: "unknown" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/utils/parseRepoInput.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parseRepoInput**

```typescript
// apps/desktop/src/utils/parseRepoInput.ts
export interface ParsedInput {
  type: "clone" | "local" | "unknown";
  owner?: string;
  repo?: string;
  cloneUrl?: string;
  localPath?: string;
}

export function parseRepoInput(input: string): ParsedInput {
  const trimmed = input.trim();
  if (!trimmed) return { type: "unknown" };

  // Local path
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return { type: "local", localPath: trimmed };
  }

  // gh repo clone command
  if (trimmed.startsWith("gh repo clone ")) {
    const remainder = trimmed.slice("gh repo clone ".length).trim();
    return parseShorthand(remainder);
  }

  // SSH URL
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { type: "clone", owner: sshMatch[1], repo: sshMatch[2], cloneUrl: trimmed };
  }

  // HTTPS URL
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { type: "clone", owner: httpsMatch[1], repo: httpsMatch[2], cloneUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git` };
  }

  // Shorthand: owner/repo (exactly two segments, no spaces)
  return parseShorthand(trimmed);
}

function parseShorthand(input: string): ParsedInput {
  const match = input.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (match) {
    return { type: "clone", owner: match[1], repo: match[2], cloneUrl: `https://github.com/${match[1]}/${match[2]}.git` };
  }
  return { type: "unknown" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/utils/parseRepoInput.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/parseRepoInput.ts apps/desktop/src/utils/parseRepoInput.test.ts
git commit -m "feat: add parseRepoInput utility with tests"
```

---

### Task 2: Add Rust commands — `git_clone`, `git_init`, `ensure_directory`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/git.rs` (add `git_clone`, `git_init`)
- Modify: `apps/desktop/src-tauri/src/commands/fs.rs` (add `ensure_directory`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:357-399` (register new commands)

- [ ] **Step 1: Add `git_clone` command to git.rs**

Append after `git_default_branch` (after line 151):

```rust
#[tauri::command]
pub async fn git_clone(url: String, destination: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["clone", &url, &destination])
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone failed: {}", stderr.trim()));
    }

    Ok(())
}
```

- [ ] **Step 2: Add `git_init` command to git.rs**

Append after `git_clone`:

```rust
#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    Repository::init(&path).map_err(|e| format!("git init failed: {}", e))?;
    Ok(())
}
```

- [ ] **Step 3: Add `ensure_directory` command to fs.rs**

```rust
#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory {}: {}", path, e))?;
    Ok(())
}
```

- [ ] **Step 4: Register commands in lib.rs**

In `lib.rs` at line ~373-383, add to the `generate_handler!` macro:

```rust
// Git commands (add after existing entries)
commands::git::git_clone,
commands::git::git_init,
// FS commands (add after existing entries)
commands::fs::ensure_directory,
```

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 6: Run clippy**

Run: `cd apps/desktop/src-tauri && cargo clippy`
Expected: No warnings

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/git.rs apps/desktop/src-tauri/src/commands/fs.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add git_clone, git_init, ensure_directory Tauri commands"
```

---

### Task 3: Add store methods — `createRepo`, `cloneAndImportRepo`

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:156-171` (add methods after `importRepo`)

- [ ] **Step 1: Add `createRepo` method**

After `importRepo` (line 171), add:

```typescript
async function createRepo(name: string, path: string) {
  const existing = await findRepoByPath(_db, path);
  if (existing) {
    if (existing.hidden) {
      await unhideRepoQuery(_db, existing.id);
      bump();
      selectedRepoId.value = existing.id;
    }
    return;
  }
  await invoke("ensure_directory", { path });
  await invoke("git_init", { path });
  const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path }).catch(() => "main");
  const id = generateId();
  await insertRepo(_db, { id, path, name, default_branch: defaultBranch });
  bump();
  selectedRepoId.value = id;
}
```

- [ ] **Step 2: Add `cloneAndImportRepo` method**

After `createRepo`, add:

```typescript
async function cloneAndImportRepo(url: string, destination: string) {
  await invoke("git_clone", { url, destination });
  const name = destination.split("/").pop() || "repo";
  const defaultBranch = await invoke<string>("git_default_branch", { repoPath: destination }).catch(() => "main");
  const id = generateId();
  await insertRepo(_db, { id, path: destination, name, default_branch: defaultBranch });
  bump();
  selectedRepoId.value = id;
}
```

- [ ] **Step 3: Expose both methods from the store**

Find the `return { ... }` block in kanna.ts and add `createRepo` and `cloneAndImportRepo` to the returned object.

- [ ] **Step 4: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "feat: add createRepo and cloneAndImportRepo store methods"
```

---

### Task 4: Update keyboard shortcuts

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:4-28,76`

- [ ] **Step 1: Add `createRepo` to ActionName union**

At line 4, add `"createRepo"` to the `ActionName` union type:

```typescript
export type ActionName =
  | "newTask"
  | "newWindow"
  | "openFile"
  | "makePR"
  | "mergeQueue"
  | "closeTask"
  | "undoClose"
  | "navigateUp"
  | "navigateDown"
  | "toggleZen"
  | "dismiss"
  | "openInIDE"
  | "openShell"
  | "showDiff"
  | "toggleMaximize"
  | "showShortcuts"
  | "toggleSidebar"
  | "commandPalette"
  | "showAnalytics"
  | "goBack"
  | "goForward"
  | "createRepo"
  | "importRepo"
  | "blockTask"
  | "editBlockedTask";
```

- [ ] **Step 2: Update shortcuts array**

Replace the existing `importRepo` entry (line 76) and add `createRepo`:

```typescript
{ action: "createRepo",  label: "Create Repo",    group: "Navigation", key: ["I", "i"],                     meta: true,               display: "⌘I",       context: ["main"] },
{ action: "importRepo",  label: "Import / Clone",  group: "Navigation", key: ["I", "i"],                     meta: true, shift: true,  display: "⇧⌘I",     context: ["main"] },
```

- [ ] **Step 3: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: Will fail — `createRepo` not in `keyboardActions` in App.vue yet. That's expected; we fix it in Task 6.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts
git commit -m "feat: add createRepo shortcut (⌘I), reassign importRepo to ⇧⌘I"
```

---

### Task 5: Create AddRepoModal component

**Files:**
- Create: `apps/desktop/src/components/AddRepoModal.vue`

This is the main UI component. It replaces ImportRepoModal with a two-tab dialog.

- [ ] **Step 1: Create AddRepoModal.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { open } from "../dialog";
import { invoke } from "../invoke";
import { parseRepoInput } from "../utils/parseRepoInput";
import type { ParsedInput } from "../utils/parseRepoInput";

const props = defineProps<{
  initialTab: "create" | "import";
}>();

const emit = defineEmits<{
  (e: "create", name: string, path: string): void;
  (e: "import", path: string, name: string, defaultBranch: string): void;
  (e: "clone", url: string, destination: string): void;
  (e: "cancel"): void;
}>();

const activeTab = ref<"create" | "import">(props.initialTab);

// ── Create New tab state ──
const createName = ref("");
const createParentDir = ref("");
const homeDir = ref("");

// ── Import / Clone tab state ──
const importInput = ref("");
const selectedLocalPath = ref<string | null>(null);
const localRepoName = ref("");
const localBranch = ref("main");
const localRemote = ref("");
const localIsGitRepo = ref(false);
const localLoading = ref(false);

// ── Shared state ──
const cloning = ref(false);
const error = ref<string | null>(null);
const inputRef = ref<HTMLInputElement>();

onMounted(async () => {
  try {
    const { homeDir: tauri_homeDir } = await import("@tauri-apps/api/path");
    homeDir.value = await tauri_homeDir();
  } catch {
    homeDir.value = "/Users/unknown";
  }
  createParentDir.value = `${homeDir.value}.kanna/repos`;
  inputRef.value?.focus();
});

// ── Create New tab logic ──
const resolvedCreateDir = computed(() => {
  if (!createName.value.trim()) return createParentDir.value;
  return `${createParentDir.value}/${createName.value.trim()}`;
});

const displayCreateDir = computed(() => {
  const full = resolvedCreateDir.value;
  if (homeDir.value && full.startsWith(homeDir.value)) {
    return "~/" + full.slice(homeDir.value.length);
  }
  return full;
});

const enumeratedCreateName = ref("");

watch([createName, createParentDir], async () => {
  const name = createName.value.trim();
  if (!name) { enumeratedCreateName.value = ""; return; }
  const enumerated = await findAvailableName(createParentDir.value, name);
  enumeratedCreateName.value = enumerated;
}, { immediate: true });

const displayCreatePath = computed(() => {
  const name = enumeratedCreateName.value || createName.value.trim();
  if (!name) return displayCreateDir.value.endsWith("/") ? displayCreateDir.value : displayCreateDir.value + "/";
  const parent = createParentDir.value;
  const full = `${parent}/${name}`;
  if (homeDir.value && full.startsWith(homeDir.value)) {
    return "~/" + full.slice(homeDir.value.length);
  }
  return full;
});

const createDisabled = computed(() => !createName.value.trim());

// ── Import / Clone tab logic ──
const parsed = computed<ParsedInput>(() => parseRepoInput(importInput.value));

const enumeratedCloneName = ref("");

watch(() => parsed.value, async (p) => {
  error.value = null;
  if (p.type === "clone" && p.repo) {
    const enumerated = await findAvailableName(createParentDir.value, p.repo);
    enumeratedCloneName.value = enumerated;
  } else {
    enumeratedCloneName.value = "";
  }
}, { immediate: true });

const cloneDestination = computed(() => {
  const p = parsed.value;
  if (p.type !== "clone" || !p.repo) return "";
  const name = enumeratedCloneName.value || p.repo;
  return `${createParentDir.value}/${name}`;
});

const displayCloneDestination = computed(() => {
  const full = cloneDestination.value;
  if (!full) return "";
  if (homeDir.value && full.startsWith(homeDir.value)) {
    return "~/" + full.slice(homeDir.value.length);
  }
  return full;
});

const importDisabled = computed(() => {
  if (cloning.value) return true;
  if (selectedLocalPath.value) return false;
  return parsed.value.type === "unknown";
});

// ── Shared helpers ──
async function findAvailableName(parentDir: string, baseName: string): Promise<string> {
  try {
    const exists = await invoke<boolean>("file_exists", { path: `${parentDir}/${baseName}` });
    if (!exists) return baseName;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${baseName}-${i}`;
      const candidateExists = await invoke<boolean>("file_exists", { path: `${parentDir}/${candidate}` });
      if (!candidateExists) return candidate;
    }
    return `${baseName}-${Date.now()}`;
  } catch {
    return baseName;
  }
}

async function handleChangeCreateDir() {
  const result = await open({ directory: true, multiple: false, title: "Choose parent directory" });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChangeCloneDir() {
  const result = await open({ directory: true, multiple: false, title: "Choose clone directory" });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChooseLocalFolder() {
  error.value = null;
  const result = await open({ directory: true, multiple: false, title: "Select a Git Repository" });
  if (!result) return;
  const dirPath = Array.isArray(result) ? result[0] : result;
  if (!dirPath) return;

  selectedLocalPath.value = dirPath;
  importInput.value = dirPath;
  const parts = dirPath.split("/");
  localRepoName.value = parts[parts.length - 1] || "repo";

  localLoading.value = true;
  try {
    const branch = await invoke<string>("git_default_branch", { repoPath: dirPath });
    localBranch.value = branch || "main";
    localIsGitRepo.value = true;
    try {
      const remote = await invoke<string>("git_remote_url", { repoPath: dirPath });
      localRemote.value = remote;
    } catch {
      localRemote.value = "";
    }
  } catch {
    localIsGitRepo.value = false;
    localBranch.value = "main";
    localRemote.value = "";
  }
  localLoading.value = false;
}

function handleSubmit() {
  if (activeTab.value === "create") {
    if (createDisabled.value) return;
    const name = enumeratedCreateName.value || createName.value.trim();
    const path = `${createParentDir.value}/${name}`;
    emit("create", name, path);
  } else {
    if (importDisabled.value) return;
    if (selectedLocalPath.value) {
      emit("import", selectedLocalPath.value, localRepoName.value, localBranch.value);
    } else if (parsed.value.type === "clone" && parsed.value.cloneUrl) {
      emit("clone", parsed.value.cloneUrl, cloneDestination.value);
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}

function switchTab(tab: "create" | "import") {
  activeTab.value = tab;
  error.value = null;
  // Reset import state when switching
  if (tab === "create") {
    selectedLocalPath.value = null;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')" @keydown="handleKeydown">
    <div class="modal">
      <!-- Tabs -->
      <div class="tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'create' }"
          @click="switchTab('create')"
        >
          Create New
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'import' }"
          @click="switchTab('import')"
        >
          Import / Clone
        </button>
      </div>

      <!-- Create New Tab -->
      <div v-if="activeTab === 'create'" class="modal-body">
        <input
          ref="inputRef"
          v-model="createName"
          class="text-input"
          type="text"
          placeholder="my-awesome-project"
          @keydown="handleKeydown"
        />
        <div class="path-hint">
          <span class="path-text">{{ displayCreatePath }}</span>
          <a v-if="createName.trim()" class="change-link" @click="handleChangeCreateDir">change</a>
        </div>
      </div>

      <!-- Import / Clone Tab -->
      <div v-if="activeTab === 'import'" class="modal-body">
        <template v-if="!selectedLocalPath">
          <input
            ref="inputRef"
            v-model="importInput"
            class="text-input"
            type="text"
            placeholder="owner/repo, URL, or gh repo clone..."
            :disabled="cloning"
            @keydown="handleKeydown"
          />
          <template v-if="parsed.type === 'clone' && parsed.owner && parsed.repo">
            <div class="resolved-url">↳ github.com/{{ parsed.owner }}/{{ parsed.repo }}</div>
            <div class="path-hint">
              <span class="path-text">{{ displayCloneDestination }}</span>
              <a class="change-link" @click="handleChangeCloneDir">change</a>
            </div>
          </template>
          <template v-else>
            <div class="path-hint">
              or <a class="change-link" @click="handleChooseLocalFolder">choose a local folder</a>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="selected-path">{{ selectedLocalPath }}</div>
          <div v-if="localLoading" class="path-hint">detecting...</div>
          <div v-else-if="localIsGitRepo" class="resolved-url">
            ✓ Git repo · branch: {{ localBranch }}<template v-if="localRemote"> · {{ localRemote }}</template>
          </div>
          <div v-else class="error-inline">
            Not a git repo. Use Create New tab to initialize one.
          </div>
          <div v-if="localIsGitRepo && !localLoading" class="name-field">
            <input
              v-model="localRepoName"
              class="text-input"
              type="text"
              placeholder="Repository name"
              @keydown="handleKeydown"
            />
          </div>
        </template>

        <div v-if="error" class="error-inline">{{ error }}</div>
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <span class="hint">
          ⌘Enter to {{ activeTab === "create" ? "create" : "import" }}
        </span>
        <div class="modal-actions">
          <button class="btn btn-cancel" @click="emit('cancel')">Cancel</button>
          <button
            v-if="activeTab === 'create'"
            class="btn btn-primary"
            :disabled="createDisabled"
            @click="handleSubmit"
          >
            Create
          </button>
          <button
            v-else
            class="btn btn-primary"
            :disabled="importDisabled"
            @click="handleSubmit"
          >
            <template v-if="cloning">
              <span class="spinner" /> Cloning...
            </template>
            <template v-else>Import</template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.tabs {
  display: flex;
  border-bottom: 1px solid #444;
}

.tab {
  flex: 1;
  padding: 12px 16px;
  font-size: 13px;
  color: #888;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  text-align: center;
}

.tab:hover {
  color: #ccc;
}

.tab.active {
  color: #fff;
  font-weight: 500;
  border-bottom-color: #0066cc;
  background: rgba(0, 102, 204, 0.08);
}

.modal-body {
  padding: 16px;
}

.text-input {
  width: 100%;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
  padding: 10px;
  outline: none;
}

.text-input:focus {
  border-color: #0066cc;
}

.text-input::placeholder {
  color: #555;
}

.text-input:disabled {
  opacity: 0.5;
}

.path-hint {
  font-size: 11px;
  color: #555;
  padding: 6px 2px 0;
}

.path-text {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
}

.change-link {
  color: #0066cc;
  cursor: pointer;
  margin-left: 4px;
}

.change-link:hover {
  color: #0077ee;
  text-decoration: underline;
}

.resolved-url {
  font-size: 11px;
  color: #0066cc;
  padding: 4px 2px 0;
}

.selected-path {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #ccc;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 10px;
}

.name-field {
  margin-top: 10px;
}

.error-inline {
  font-size: 11px;
  color: #f85149;
  padding: 6px 2px 0;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 14px;
}

.hint {
  font-size: 11px;
  color: #555;
}

.modal-actions {
  display: flex;
  gap: 8px;
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  border: 1px solid #444;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.btn-cancel {
  background: #2a2a2a;
  color: #ccc;
}

.btn-cancel:hover {
  background: #333;
}

.btn-primary {
  background: #0066cc;
  border-color: #0077ee;
  color: #fff;
}

.btn-primary:hover {
  background: #0077ee;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
```

- [ ] **Step 2: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: May have errors from App.vue not yet updated — that's expected. AddRepoModal.vue itself should have no internal type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/AddRepoModal.vue
git commit -m "feat: add AddRepoModal component with tabbed create/import/clone UI"
```

---

### Task 6: Wire up App.vue — replace ImportRepoModal with AddRepoModal

**Files:**
- Modify: `apps/desktop/src/App.vue:44,239-323,367-370,388-427`

- [ ] **Step 1: Update imports**

Replace `ImportRepoModal` import with `AddRepoModal` at the top of `<script setup>`. Find the import line for `ImportRepoModal` and change to:

```typescript
import AddRepoModal from "./components/AddRepoModal.vue";
```

- [ ] **Step 2: Update UI state refs**

Replace line 44:

```typescript
const showImportRepoModal = ref(false);
```

with:

```typescript
const showAddRepoModal = ref(false);
const addRepoInitialTab = ref<"create" | "import">("create");
```

- [ ] **Step 3: Update keyboard actions**

In the `keyboardActions` object, replace line 320:

```typescript
importRepo: () => { showImportRepoModal.value = true; },
```

with:

```typescript
createRepo: () => { addRepoInitialTab.value = "create"; showAddRepoModal.value = true; },
importRepo: () => { addRepoInitialTab.value = "import"; showAddRepoModal.value = true; },
```

- [ ] **Step 4: Update dismiss handler**

In the `dismiss` action (line 284), replace:

```typescript
if (showImportRepoModal.value) { showImportRepoModal.value = false; focusAgentTerminal(); return; }
```

with:

```typescript
if (showAddRepoModal.value) { showAddRepoModal.value = false; focusAgentTerminal(); return; }
```

- [ ] **Step 5: Update/add handler functions**

Replace `handleImportRepo` (lines 367-370) with three handlers:

```typescript
async function handleCreateRepo(name: string, path: string) {
  try {
    await store.createRepo(name, path);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`Failed to create repo: ${msg}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showAddRepoModal.value = false;
}

async function handleCloneRepo(url: string, destination: string) {
  try {
    await store.cloneAndImportRepo(url, destination);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`Clone failed: ${msg}`);
  }
}
```

- [ ] **Step 6: Update template**

Replace lines 423-427:

```vue
<ImportRepoModal
  v-if="showImportRepoModal"
  @import="handleImportRepo"
  @cancel="showImportRepoModal = false"
/>
```

with:

```vue
<AddRepoModal
  v-if="showAddRepoModal"
  :initial-tab="addRepoInitialTab"
  @create="handleCreateRepo"
  @import="handleImportRepo"
  @clone="handleCloneRepo"
  @cancel="showAddRepoModal = false"
/>
```

- [ ] **Step 7: Update Sidebar event handler**

Replace line 399:

```vue
@import-repo="showImportRepoModal = true"
```

with:

```vue
@add-repo="addRepoInitialTab = 'import'; showAddRepoModal = true"
```

- [ ] **Step 8: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire AddRepoModal into App.vue, replace ImportRepoModal"
```

---

### Task 7: Update Sidebar and MainPanel references

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:18,164-166,412-414`
- Modify: `apps/desktop/src/components/MainPanel.vue:54-56`

- [ ] **Step 1: Update Sidebar emit**

In Sidebar.vue line 18, replace:

```typescript
(e: "import-repo"): void;
```

with:

```typescript
(e: "add-repo"): void;
```

- [ ] **Step 2: Update Sidebar empty state**

Replace lines 164-166:

```html
<div v-if="repos.length === 0" class="empty-state">
  No repos imported yet.<br>
  Press <kbd>⇧</kbd><kbd>⌘</kbd><kbd>I</kbd> to import one.
</div>
```

with:

```html
<div v-if="repos.length === 0" class="empty-state">
  No repos yet.<br>
  Press <kbd>⌘</kbd><kbd>I</kbd> to create one.
</div>
```

- [ ] **Step 3: Update Sidebar footer button**

Replace lines 412-414:

```html
<button class="btn-import" @click="emit('import-repo')" title="Import Repo (⇧⌘I)">
  Import Repo
</button>
```

with:

```html
<button class="btn-import" @click="emit('add-repo')" title="Add Repo (⌘I)">
  Add Repo
</button>
```

- [ ] **Step 4: Update MainPanel empty state**

Replace lines 54-56:

```html
<template v-if="!hasRepos">
  <p class="empty-title">No repos imported</p>
  <p class="empty-hint">Press <kbd>⇧</kbd><kbd>⌘</kbd><kbd>I</kbd> to import a repo and get started.</p>
</template>
```

with:

```html
<template v-if="!hasRepos">
  <p class="empty-title">No repos yet</p>
  <p class="empty-hint">Press <kbd>⌘</kbd><kbd>I</kbd> to create a repo and get started.</p>
</template>
```

- [ ] **Step 5: Run type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue apps/desktop/src/components/MainPanel.vue
git commit -m "feat: update Sidebar and MainPanel to reference new Add Repo flow"
```

---

### Task 8: Delete old ImportRepoModal

**Files:**
- Delete: `apps/desktop/src/components/ImportRepoModal.vue`

- [ ] **Step 1: Remove ImportRepoModal.vue**

```bash
rm apps/desktop/src/components/ImportRepoModal.vue
```

- [ ] **Step 2: Verify no remaining references**

Run: `grep -r "ImportRepoModal" apps/desktop/src/`
Expected: No results

- [ ] **Step 3: Run full type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Run all existing tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete old ImportRepoModal, replaced by AddRepoModal"
```

---

### Task 9: Manual smoke test

No code changes — verify the feature works end-to-end.

- [ ] **Step 1: Start dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Test Create New (⌘I)**

1. Press ⌘I — dialog opens to Create New tab
2. Type "test-project" — path shows `~/.kanna/repos/test-project`
3. Press ⌘Enter — repo is created and appears in sidebar
4. Verify `~/.kanna/repos/test-project` exists and has `.git`

- [ ] **Step 3: Test name enumeration**

1. Press ⌘I again
2. Type "test-project" — path should show `~/.kanna/repos/test-project-2` (since test-project exists)

- [ ] **Step 4: Test Import / Clone (⇧⌘I)**

1. Press ⇧⌘I — dialog opens to Import / Clone tab
2. Type `jemdiggity/kanna-v2` — resolved URL appears, clone destination shows
3. Click "choose a local folder" — native picker opens, select a git repo, info displays

- [ ] **Step 5: Test tab switching and escape**

1. Open dialog with ⌘I, click Import/Clone tab, verify switch
2. Press Escape — dialog closes

- [ ] **Step 6: Test sidebar button**

1. Click "Add Repo" button in sidebar footer — dialog opens to Import/Clone tab

- [ ] **Step 7: Clean up test repos**

```bash
rm -rf ~/.kanna/repos/test-project ~/.kanna/repos/test-project-2
```
