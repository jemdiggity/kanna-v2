# Mobile Repo Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mobile More maintenance/task commands with a selected-repository catalog of factory commands and repo-defined automations that the desktop server lists and launches.

**Architecture:** `kanna-server` owns catalog discovery, revisioning, and execution through two repo-scoped endpoints. Mobile routes those endpoints through the owning desktop, keeps catalog/launch state in the session store, and renders a searchable grouped palette. Desktop retains its non-repo commands while consuming the same server catalog for factory and custom-task entries.

**Tech Stack:** Rust/Axum/Serde/SQLite/daemon task spawning, TypeScript, React Native, Vue 3, Vitest, Rust tests.

**Stage constraint:** Do not create implementation commits in this Kanna stage; use verification checkpoints and leave changes for the workflow's later commit step.

---

## File Structure

- Create `crates/kanna-server/src/repo_commands.rs` — command catalog types, built-in/local custom-task discovery, revision calculation, factory/custom launch preparation.
- Modify `crates/kanna-server/src/lib.rs` — register the repo-command module.
- Modify `crates/kanna-server/src/http_api.rs` and `crates/kanna-server/src/http_api/router.rs` — register handlers and routes.
- Create `crates/kanna-server/src/http_api/repo_commands.rs` — list/run handlers and HTTP error mapping.
- Create `crates/kanna-server/src/http_api/tests/repo_commands.rs` and modify `crates/kanna-server/src/http_api/tests.rs` — endpoint contract coverage.
- Modify `crates/kanna-server/src/task_creator/mod.rs` as narrowly needed to expose existing task preparation/spawn helpers to the command runner.
- Modify `apps/mobile/src/lib/api/types.ts` and `apps/mobile/src/lib/api/client.ts` — repo-command contracts and client methods.
- Modify `apps/mobile/src/lib/transports/lanTransport.ts`, `remoteTransport.ts`, and `apps/mobile/src/lib/sources/cloudLanClient.ts` — routed list/run behavior.
- Modify matching transport/client tests — exact URL, body, route-identity, and response mapping coverage.
- Modify `apps/mobile/src/state/sessionStore.ts` and tests — catalog and single-flight state.
- Modify `apps/mobile/src/state/mobileController.ts` and tests — load/run orchestration and task navigation.
- Replace `apps/mobile/src/screens/moreCommands.ts` with `apps/mobile/src/screens/repoCommandPresentation.ts`; replace matching tests.
- Modify `apps/mobile/src/screens/MoreScreen.tsx` and add `MoreScreen.test.tsx` — selected-repo palette UI.
- Modify `apps/mobile/src/App.tsx` and `App.component.test.tsx` — new screen wiring and removal of task callbacks.
- Modify `apps/desktop/src/services/desktopServerClient.ts`, its tests, and `apps/desktop/src/composables/useAppTaskNavigation.ts` tests/implementation — repo commands use the server catalog while task/machine/static commands remain local.

### Task 1: Server Catalog Domain

**Files:**
- Create: `crates/kanna-server/src/repo_commands.rs`
- Modify: `crates/kanna-server/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `crates/kanna-server/src/repo_commands.rs`

- [ ] **Step 1: Write failing catalog tests**

Add tests proving:

```rust
#[test]
fn catalog_groups_factory_and_repo_automation_commands() {
    let repo = fixture_repo_with_task("deploy", r#"---
name: Deploy
description: Deploy this repository
execution_mode: pty
---
Deploy safely.
"#);
    let catalog = build_repo_command_catalog(&repo).unwrap();
    assert_eq!(catalog.commands[0].group, RepoCommandGroup::Automation);
    assert!(catalog.commands.iter().any(|command| command.label == "Deploy"));
    assert!(catalog.commands.iter().any(|command| command.id == "factory:create-agent"));
}

#[test]
fn local_task_definition_overrides_same_slug_builtin() {
    let repo = fixture_repo_with_task("merge-master", r#"---
name: Local Merge Queue
description: Use the repository-specific merge policy
agent: merge
---
"#);
    let catalog = build_repo_command_catalog(&repo).unwrap();
    let command = catalog.commands.iter().find(|command| command.id == "custom:merge-master").unwrap();
    assert_eq!(command.label, "Local Merge Queue");
    assert_eq!(command.description, "Use the repository-specific merge policy");
}

#[test]
fn catalog_revision_changes_with_task_definition_content() {
    let repo = fixture_repo_with_task("deploy", "Deploy version one.");
    let first = build_repo_command_catalog(&repo).unwrap();
    std::fs::write(repo.path.join(".kanna/tasks/deploy/agent.md"), "Deploy version two.").unwrap();
    let second = build_repo_command_catalog(&repo).unwrap();
    assert_ne!(first.revision, second.revision);
}

#[test]
fn custom_task_ids_use_slug_not_display_name() {
    let repo = fixture_repo_with_task("deploy", "---\nname: Production Release\n---\nDeploy safely.");
    let catalog = build_repo_command_catalog(&repo).unwrap();
    assert!(catalog.commands.iter().any(|command| command.id == "custom:deploy"));
    assert!(!catalog.commands.iter().any(|command| command.id.contains("Production Release")));
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
cargo test -p kanna-server repo_commands::tests -- --nocapture
```

Expected: compilation fails because `repo_commands` and its catalog functions do not exist.

- [ ] **Step 3: Implement catalog types and discovery**

Implement these public contracts:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommandCatalog {
    pub repo_id: String,
    pub revision: String,
    pub commands: Vec<RepoCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommand {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: RepoCommandGroup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RepoCommandGroup { Automation, Configure }

pub fn build_repo_command_catalog(repo: &crate::db::Repo) -> Result<RepoCommandCatalog, RepoCommandError>;
```

Use fixed factory definitions for `setup-repo`, `create-config`, `create-agent`, `create-workflow`, and `new-custom-task`. Compile the built-in Merge Master and Ship task files with `include_str!`, overlay local `<repo>/.kanna/tasks/<slug>/agent.md` files by slug, parse the existing frontmatter fields with `serde_yaml`, and skip incomplete definitions consistently with `@kanna/core`.

Calculate a deterministic revision from sorted command IDs plus launch-relevant definition content. Use a stable standard-library hash representation or add `sha2 = "0.10"` to `crates/kanna-server/Cargo.toml`; do not use randomized `DefaultHasher` output.

- [ ] **Step 4: Re-run catalog tests and verify GREEN**

Run the focused command from Step 2. Expected: all catalog tests pass.

- [ ] **Step 5: Run formatting checkpoint**

Run:

```bash
cargo fmt --all -- --check
git diff --check
```

Expected: both exit 0.

### Task 2: Server Command Execution and HTTP Contract

**Files:**
- Modify: `crates/kanna-server/src/repo_commands.rs`
- Create: `crates/kanna-server/src/http_api/repo_commands.rs`
- Modify: `crates/kanna-server/src/http_api.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests.rs`
- Create: `crates/kanna-server/src/http_api/tests/repo_commands.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`

- [ ] **Step 1: Write failing HTTP tests**

Add route tests for:

```rust
#[tokio::test]
async fn lists_repo_commands_with_revision_and_groups() {
    let app = repo_command_test_router().await;
    let response = app.oneshot(Request::get("/v1/repos/repo-1/commands").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: RepoCommandCatalog = read_json(response).await;
    assert!(!body.revision.is_empty());
    assert!(body.commands.iter().any(|command| command.group == RepoCommandGroup::Configure));
}

#[tokio::test]
async fn rejects_run_with_stale_catalog_revision() {
    let app = repo_command_test_router().await;
    let response = app.oneshot(json_request(
        Method::POST,
        "/v1/repos/repo-1/commands/factory%3Acreate-agent/run",
        serde_json::json!({ "catalogRevision": "stale" }),
    )).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn runs_factory_command_and_returns_task_identity() {
    let (app, revision, captured) = repo_command_runner_test_router().await;
    let response = app.oneshot(json_request(
        Method::POST,
        "/v1/repos/repo-1/commands/factory%3Acreate-agent/run",
        serde_json::json!({ "catalogRevision": revision }),
    )).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(read_json::<RunRepoCommandResponse>(response).await.task_id, "created-command-task");
    assert_eq!(captured.lock().unwrap().prompt, "Help me create a new agent definition for this repository.");
}

#[tokio::test]
async fn runs_custom_task_with_all_frontmatter_overrides() {
    let (app, revision, captured) = custom_command_runner_test_router().await;
    let response = app.oneshot(json_request(
        Method::POST,
        "/v1/repos/repo-1/commands/custom%3Adeploy/run",
        serde_json::json!({ "catalogRevision": revision }),
    )).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let launch = captured.lock().unwrap().clone();
    assert_eq!(launch.agent_provider.as_deref(), Some("codex"));
    assert_eq!(launch.model.as_deref(), Some("gpt-5.4-mini"));
    assert_eq!(launch.allowed_tools, Some(vec!["Bash".to_string()]));
    assert_eq!(launch.setup_cmds, Some(vec!["pnpm install".to_string()]));
}

#[tokio::test]
async fn reuses_open_merge_singleton() {
    let (app, revision) = merge_singleton_test_router("merge-task").await;
    let response = app.oneshot(json_request(
        Method::POST,
        "/v1/repos/repo-1/commands/custom%3Amerge-master/run",
        serde_json::json!({ "catalogRevision": revision }),
    )).await.unwrap();
    let body: RunRepoCommandResponse = read_json(response).await;
    assert_eq!(body.task_id, "merge-task");
    assert!(body.reused);
}

#[tokio::test]
async fn rejects_unknown_repo_and_command() {
    let app = repo_command_test_router().await;
    let missing_repo = app.clone().oneshot(Request::get("/v1/repos/missing/commands").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(missing_repo.status(), StatusCode::NOT_FOUND);
    let missing_command = app.oneshot(json_request(
        Method::POST,
        "/v1/repos/repo-1/commands/custom%3Amissing/run",
        serde_json::json!({ "catalogRevision": current_revision() }),
    )).await.unwrap();
    assert_eq!(missing_command.status(), StatusCode::NOT_FOUND);
}
```

Use the existing `test_router` harness and a test runner hook that captures a resolved launch request without spawning a real daemon.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run:

```bash
cargo test -p kanna-server http_api::tests::repo_commands -- --nocapture
```

Expected: tests fail because the routes are absent.

- [ ] **Step 3: Implement list/run handlers**

Register:

```rust
.route("/v1/repos/{repo_id}/commands", get(list_repo_commands))
.route("/v1/repos/{repo_id}/commands/{command_id}/run", post(run_repo_command))
```

Use request/response bodies:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRepoCommandRequest { catalog_revision: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRepoCommandResponse { task_id: String, reused: bool }
```

Map missing repo/command to 404, stale revision to 409, malformed definitions to 422, and preparation/spawn failures to 500. Publish `StateChangeScope::Tasks` before and after detached spawning, matching singleton-agent behavior.

- [ ] **Step 4: Implement launch resolution**

Resolve factory commands to the exact current desktop prompts/agents:

```text
Create Agent -> "Help me create a new agent definition for this repository."
Create Workflow -> "Help me create a new workflow definition for this repository."
Set Up Repository -> agent `setup`, prompt "Set up Kanna for this repository."
Create Config -> agent `config-factory`, prompt "Help me create or update the .kanna/config.json for this repository."
New Custom Task -> the existing NEW_CUSTOM_TASK_PROMPT text
```

Resolve custom-task launch fields into `CreateTaskRequest`. For the Merge Master `agent: merge` definition, use the existing repo-scoped singleton lookup/preparation and return `{ reused: true }` when already open. Other custom tasks create normal tasks.

- [ ] **Step 5: Re-run endpoint and server tests**

Run:

```bash
cargo test -p kanna-server http_api::tests::repo_commands -- --nocapture
cargo test -p kanna-server repo_commands::tests -- --nocapture
```

Expected: all focused tests pass.

### Task 3: Mobile API and Transport Propagation

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`

- [ ] **Step 1: Write failing client and transport tests**

Define expected calls:

```ts
await client.listRepoCommands("repo-1");
await client.runRepoCommand("repo-1", "custom:merge-master", "rev-1");
```

Assert LAN uses:

```text
GET /v1/repos/repo-1/commands
POST /v1/repos/repo-1/commands/custom%3Amerge-master/run
{"catalogRevision":"rev-1"}
```

Assert remote routing translates a cloud repo ID to the owning desktop/local repo ID and canonicalizes the returned task ID exactly as task creation does. Assert cloud/LAN fallback never sends the command to a different desktop.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts src/lib/transports/remoteTransport.test.ts src/lib/sources/cloudLanClient.test.ts
```

Expected: TypeScript/tests fail because repo-command methods and types are absent.

- [ ] **Step 3: Add shared mobile types and methods**

Add:

```ts
export interface RepoCommand {
  id: string;
  label: string;
  description: string;
  group: "automation" | "configure";
}
export interface RepoCommandCatalog {
  repoId: string;
  revision: string;
  commands: RepoCommand[];
}
export interface RunRepoCommandResponse {
  taskId: string;
  reused: boolean;
  ownerDesktopId?: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId?: string;
}
```

Add `listRepoCommands(repoId)` and `runRepoCommand(repoId, commandId, catalogRevision)` to `KannaTransport`, `KannaClient`, every mock, and `createKannaClient`.

- [ ] **Step 4: Implement LAN, remote, and cloud/LAN routing**

Reuse `resolveCloudRepoRoute` and provisional task routing. A returned local task ID becomes a canonical cloud task ID when the command ran through a cloud owner route. Preserve the local response unchanged on direct LAN.

- [ ] **Step 5: Re-run focused tests and verify GREEN**

Run the command from Step 2. Expected: all listed files pass.

### Task 4: Mobile Store and Controller Orchestration

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Write failing store tests**

Add state:

```ts
repoCommandCatalog: RepoCommandCatalog | null;
repoCommandStatus: "idle" | "loading" | "ready" | "error";
repoCommandError: string | null;
runningRepoCommandId: string | null;
```

Test that selecting a different repo clears the previous catalog immediately and that catalog mutations publish only when state changes.

- [ ] **Step 2: Run store tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: tests fail because repo-command state/mutators are absent.

- [ ] **Step 3: Implement minimal store state**

Add mutators `beginRepoCommandLoad`, `setRepoCommandCatalog`, `setRepoCommandError`, and `setRunningRepoCommand`. Clear catalog/error/running ID inside `selectRepo` when the repo changes.

- [ ] **Step 4: Write failing controller tests**

Cover:

```ts
controller.showView("more"); // loads selected repo catalog
await controller.selectRepo("repo-2"); // reloads while More active
await controller.runRepoCommand("custom:ship"); // one request, refresh, open returned task
```

Assert repeated calls while one command is running return the same flight or no-op without a second API call. Assert 409 reloads the catalog and surfaces a retry message. Assert offline/load/run failures retain More and clear running state.

- [ ] **Step 5: Run controller tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts
```

Expected: tests fail because controller methods are absent.

- [ ] **Step 6: Implement controller methods**

Add `loadRepoCommands()` and `runRepoCommand(commandId)`. `showView("more")` starts a load. `selectRepo` reloads when More is active. On run success, increment task collection revision, refresh, resolve canonical task identity, and call `openTask` using the returned task ID. Use one module-local launch promise/ID to enforce single flight.

- [ ] **Step 7: Re-run store/controller tests and verify GREEN**

Run both focused files. Expected: all pass.

### Task 5: More Presentation and React Native UI

**Files:**
- Delete: `apps/mobile/src/screens/moreCommands.ts`
- Delete: `apps/mobile/src/screens/moreCommands.test.ts`
- Create: `apps/mobile/src/screens/repoCommandPresentation.ts`
- Create: `apps/mobile/src/screens/repoCommandPresentation.test.ts`
- Modify: `apps/mobile/src/screens/MoreScreen.tsx`
- Create: `apps/mobile/src/screens/MoreScreen.test.tsx`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts` if stable UI IDs are needed

- [ ] **Step 1: Write failing presentation tests**

Test:

```ts
expect(buildRepoCommandSections(catalog, "merge")).toEqual([
  { title: "Automations", commands: [expect.objectContaining({ id: "custom:merge-master" })] }
]);
```

Also test case-insensitive label/description search, stable group ordering, empty automation omission, and Configure Repository remaining visible when no automations exist.

- [ ] **Step 2: Run presentation tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/repoCommandPresentation.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure presentation model**

Export `buildRepoCommandSections(catalog, query)` returning ordered nonempty sections and filtered commands. Keep network/loading logic outside this module.

- [ ] **Step 4: Write failing MoreScreen component tests**

Render loading, ready, error, no-repo, and running states. Assert the ready screen shows selected repo, grouped commands, and search. Assert it never renders `Create Task`, `Refresh Data`, `Start Pairing`, `Switch Desktop`, `App update`, `Advance Stage`, `Run Merge Agent`, or `Close Task`.

- [ ] **Step 5: Run component tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/MoreScreen.test.tsx
```

Expected: old props/UI cause assertion and type failures.

- [ ] **Step 6: Replace MoreScreen and wire App**

Use props:

```ts
interface MoreScreenProps {
  repos: RepoSummary[];
  selectedRepoId: string | null;
  catalog: RepoCommandCatalog | null;
  status: RepoCommandStatus;
  errorMessage: string | null;
  runningCommandId: string | null;
  onSelectRepo(repoId: string): void;
  onRetry(): void;
  onRunCommand(commandId: string): void;
}
```

Render a compact repo selector using the existing repo list, local search, section labels, descriptions, progress state, retry/error empty states, and bottom padding for the floating toolbar. Remove `selectedTask`, refresh, pairing, desktop, composer, stage, merge, close callbacks, and update rows from `App.tsx`.

- [ ] **Step 7: Re-run presentation, component, and App wiring tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/repoCommandPresentation.test.ts src/screens/MoreScreen.test.tsx src/App.component.test.tsx src/navigation/RootNavigator.test.ts
```

Expected: all pass.

### Task 6: Desktop Repo-Command Catalog Compatibility

**Files:**
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.test.ts`
- Modify: `apps/desktop/src/App.test.ts` only where command expectations change

- [ ] **Step 1: Write failing desktop client tests**

Assert the desktop server client calls the same repo list/run endpoints with catalog revision and parses the returned task identity.

- [ ] **Step 2: Write failing palette compatibility tests**

Assert repo catalog entries populate dynamic palette commands, running one calls the server command endpoint, and Rename/Push/Pair/Block/static shortcut commands remain present and unchanged. Assert local factory prompt copies are no longer invoked.

- [ ] **Step 3: Run focused desktop tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopServerClient.test.ts src/composables/useAppTaskNavigation.test.ts
```

Expected: missing client methods and old local command implementation failures.

- [ ] **Step 4: Implement the narrow desktop migration**

Load repo commands when the selected repo changes or palette opens, map them to `DynamicCommand`, and run through the desktop server. Retain all task/machine/static palette entries. Remove only the duplicated factory/custom-task launch functions and their prompt constants from `useAppTaskNavigation` after the server path is covered.

- [ ] **Step 5: Re-run focused desktop tests and verify GREEN**

Run the command from Step 3. Expected: all pass.

### Task 7: Full Verification and Scope Audit

**Files:**
- Review all files above
- Review: `docs/superpowers/specs/2026-07-17-mobile-repo-command-palette-design.md`

- [ ] **Step 1: Run formatting and type checks**

```bash
cargo fmt --all -- --check
pnpm --dir apps/mobile run typecheck
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Run complete mobile tests**

```bash
pnpm --dir apps/mobile test -- --runInBand
```

Expected: zero failures.

- [ ] **Step 3: Run canonical Rust tests**

```bash
./kd test rust
```

Expected: zero failures.

- [ ] **Step 4: Run affected desktop tests**

```bash
pnpm --dir apps/desktop test -- src/services/desktopServerClient.test.ts src/composables/useAppTaskNavigation.test.ts src/App.test.ts
```

Expected: zero failures.

- [ ] **Step 5: Audit requirements and worktree state**

Confirm from `git diff` that:

- More contains only repo factory/custom-task commands.
- Task actions and Machines UI were not implemented or changed beyond removing old More callbacks.
- New Task remains only on the global `+` action.
- Server and clients share the list/run contract and revision guard.
- Desktop repo commands use the server catalog.
- No unrelated user changes were modified.

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only planned files are changed and diff checks are clean.
