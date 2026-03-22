# Repo Import Flow Redesign

## Summary

Replace the current repo import modal (file picker → separate modal) with a tabbed "Add Repository" dialog that supports three workflows: creating new repos, importing local repos, and cloning from GitHub — all from a single, compact dialog.

## Motivation

The current import flow requires multiple steps (keyboard shortcut → native file picker → modal with name/branch → click Import) and only supports importing existing local repos. Users need to clone from GitHub URLs and create new repos from scratch without leaving Kanna.

## Design

### Tabbed Dialog

A single modal with two tabs: **Create New** and **Import / Clone**.

- **⌘I** opens the dialog to the **Create New** tab
- **⇧⌘I** opens the dialog to the **Import / Clone** tab
- **⌘Enter** submits the active tab's form
- **Escape** closes the dialog
- Tabs are switchable by clicking

### Create New Tab

A single input field with placeholder `my-awesome-project`. Below the input, a muted path line shows where the repo will be created: `~/.kanna/repos/<name>`. A "change" link appears next to the resolved path when a name is entered, opening a native folder picker to override the default location.

**Behavior:**
1. User types a repo name
2. Path resolves to `~/.kanna/repos/<name>` (default)
3. User optionally clicks "change" to pick a different parent directory
4. ⌘Enter or click "Create" → `git init` at the resolved path → repo imported into Kanna

**Default repo directory:** `~/.kanna/repos/`. Created automatically on first use. No configuration required.

**Name collision handling:** If the resolved directory already exists (for both Create New and Clone), auto-enumerate by appending `-2`, `-3`, etc. The dialog shows the enumerated name in the path line so the user sees what will actually be created. For example, if `~/.kanna/repos/my-project` exists, the path shows `~/.kanna/repos/my-project-2`. The check runs on each keystroke (Create New) or after parsing (Clone). The user can still override via the "change" link.

**Footer:** Bottom-left hint text: "⌘Enter to create". Bottom-right: Cancel and Create buttons. Create button is disabled (greyed out) until a name is entered. Matches the NewTaskModal footer pattern.

### Import / Clone Tab

A single input field with placeholder `owner/repo, URL, or gh repo clone...`. Below the input, muted text: "or [choose a local folder]" where "choose a local folder" is a clickable link that opens the native folder picker.

**Smart input parsing** — the input field accepts multiple formats and auto-detects intent:

| Input | Detected As |
|-------|-------------|
| `https://github.com/owner/repo` | Clone URL |
| `https://github.com/owner/repo.git` | Clone URL |
| `git@github.com:owner/repo.git` | Clone URL (SSH) |
| `owner/repo` | GitHub shorthand → clone |
| `gh repo clone owner/repo` | gh CLI command → clone |
| `/path/to/local/repo` | Local path → import directly |

**Clone flow:**
1. User pastes/types a URL or shorthand
2. Below the input, a resolved line appears: `↳ github.com/owner/repo` (in accent color)
3. Below that, the clone destination: `~/.kanna/repos/<repo-name>` with a "change" link
4. ⌘Enter or click "Import" → clone repo to destination → import into Kanna

**Local folder flow:**
1. User clicks "choose a local folder" link
2. Native folder picker opens
3. After selection, the input area shows the selected path
4. Below it: `✓ Git repo · branch: main · remote: github.com/...` (detected git info)
5. An editable name field appears below, defaulting to the folder name
6. ⌘Enter or click "Import" → repo imported into Kanna

**Footer:** Bottom-left hint text: "⌘Enter to import". Bottom-right: Cancel and Import buttons. Import button is disabled until valid input is provided.

### Input Parsing Logic

```typescript
interface ParsedInput {
  type: 'clone' | 'local' | 'unknown'
  owner?: string        // GitHub owner
  repo?: string         // GitHub repo name
  cloneUrl?: string     // Full git clone URL
  localPath?: string    // Absolute local path
}

function parseRepoInput(input: string): ParsedInput
```

Parsing priority:
1. Starts with `/` or `~` → local path (assign raw input to `localPath`)
2. Starts with `gh repo clone ` → strip prefix, parse remainder as shorthand
3. Starts with `git@github.com:` → extract owner/repo, use raw input as `cloneUrl`
4. Starts with `https://github.com/` → extract owner/repo, construct `cloneUrl`
5. Matches `<word>/<word>` pattern (no spaces, no extra slashes) → GitHub shorthand, construct `cloneUrl` as `https://github.com/{owner}/{repo}.git`
6. Otherwise → unknown (keep Import disabled)

### Clone Execution

Cloning runs `git clone` via a new Tauri command. The dialog replaces the Import button with a spinner and disables all inputs while cloning. No streaming progress — just a blocking spinner. For large repos this may take a while, but the dialog remains responsive (the Tauri command runs on a background thread). On success, the repo is imported and the dialog closes. On failure, an error message appears inline and the user can retry.

```rust
#[tauri::command]
async fn git_clone(url: String, destination: String) -> Result<(), String>
```

The `git clone` command constructs the HTTPS URL from the parsed owner/repo: `https://github.com/{owner}/{repo}.git`. Authentication for private repos uses `KANNA_GITHUB_TOKEN` if set (passed via `GIT_ASKPASS` or credential helper), otherwise relies on the user's existing git credential configuration.

### Database Changes

No schema changes needed. The existing `repo` table (`id`, `path`, `name`, `default_branch`, `hidden`, `created_at`, `last_opened_at`) handles all three workflows. The `path` field stores the final location whether created, cloned, or imported.

### Keyboard Shortcut Changes

| Old | New | Action |
|-----|-----|--------|
| ⇧⌘I | ⌘I | Open dialog → Create New tab |
| — | ⇧⌘I | Open dialog → Import / Clone tab |

The old ⇧⌘I shortcut is reassigned. The simpler ⌘I now opens to the quick-create flow.

### Component Changes

- **ImportRepoModal.vue** → renamed/replaced with **AddRepoModal.vue**
  - Two-tab layout with shared footer
  - Props: `initialTab: 'create' | 'import'` — controls which tab is active on open
  - Emits: `@create(name, path)`, `@import(path, name, defaultBranch)`, `@clone(url, destination)`, `@cancel`
  - Smart input parsing for Import/Clone tab
  - `~/.kanna/repos/` default directory management
- **App.vue** — single `showAddRepoModal` ref + `addRepoInitialTab` ref. Update event handlers:
  - `@add-repo` from Sidebar → open modal to Import/Clone tab
  - `createRepo` keyboard action → open modal to Create New tab
  - `importRepo` keyboard action → open modal to Import/Clone tab
- **useKeyboardShortcuts.ts** — add `createRepo` to `ActionName` union. Add shortcut entry `{ key: 'i', meta: true, action: 'createRepo', ... }`. Update existing `importRepo` entry to keep ⇧⌘I.
- **Sidebar.vue** — rename `import-repo` emit to `add-repo`. Update footer button label to "Add Repo" with tooltip "Add Repo (⌘I)". Update empty state hint to reference ⌘I.
- **MainPanel.vue** — update empty state hint text to reference ⌘I

### Store Changes

- **kanna.ts** — add `createRepo(name: string, path: string)` method:
  1. Create directory at `path` if it doesn't exist
  2. Run `git init` in the directory
  3. Detect default branch
  4. Insert into `repo` table
  5. Set as selected repo
- **kanna.ts** — add `cloneAndImportRepo(url: string, destination: string)` method:
  1. Run `git clone url destination` via Tauri command
  2. Detect default branch and repo name
  3. Insert into `repo` table
  4. Set as selected repo
- Existing `importRepo` method remains for the local folder flow

### Tauri Command Changes

New commands in `git.rs`:
- `git_clone(url, destination)` — runs `git clone`, returns success/error
- `git_init(path)` — runs `git init`, returns success/error
- `ensure_directory(path)` — creates directory recursively if it doesn't exist (add to existing `fs.rs`)

### Path Resolution

All paths displayed with `~` in the UI must be resolved to absolute paths before passing to any Tauri command. Use `homeDir()` from `@tauri-apps/api/path` to expand `~` to the user's home directory. The display layer shows `~/.kanna/repos/...` for readability, but all Tauri invocations use the fully expanded path (e.g., `/Users/jane/.kanna/repos/...`).

### Error Handling

- **Invalid repo name** (empty, contains `/`, etc.) → Create button stays disabled
- **Directory already exists** at create/clone path → auto-enumerate name (e.g., `my-project-2`), shown in path line
- **Clone fails** (network, auth, invalid URL) → inline error in dialog, user can retry
- **Not a git repo** (local folder import) → inline warning: "Not a git repo. Use Create New tab to initialize one."
- **Duplicate repo** (path already imported) → unhide if hidden, otherwise select existing (current behavior)

### Validation

- Create New: name must be non-empty and a valid directory name
- Import/Clone: input must parse to a known type before Import enables
- Local folder: must exist and be accessible

## Out of Scope

- Listing user's GitHub repos as suggestions
- Batch import of multiple repos
- Configuring the default repo directory (always `~/.kanna/repos/`)
- SSH key management (SSH clone is attempted as-is; auth failures show the git error)
- Git LFS handling
