# Origin-Default Kanna Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every live repository-owned Kanna config, pipeline, agent, and extension read from one freshly fetched `origin/<default_branch>` commit instead of the local checkout.

**Architecture:** Add a Git-object-backed `RepoDefinitionSnapshot`, then wrap it in `RepoDefinitions` so config is parsed once and every definition read in one orchestration operation is pinned to the same commit. Keep the server as the source of truth and expose revisioned manifest/pipeline/agent endpoints to desktop consumers; the durable task `pipeline_def` snapshot remains authoritative for existing tasks.

**Tech Stack:** Rust 2021, `std::process::Command`, serde/serde_json/serde_yaml, Axum, Vue 3/Pinia, TypeScript, Vitest, pnpm, Cargo.

**Stage constraint:** Do not create commits in this Kanna stage. The pipeline's later commit step owns committing all implementation and documentation changes.

---

## File Structure

- Create `crates/kanna-server/src/task_creator/definition_source.rs`: fetch/resolve/read/list operations against an immutable remote commit.
- Modify `crates/kanna-server/src/task_creator/definitions.rs`: `RepoDefinitions`, complete config parsing/serialization, definition parsing, builtin fallback, wire DTO conversion, and safe-name validation.
- Modify `crates/kanna-server/src/task_creator/mod.rs`, `prompt.rs`, `stages.rs`, `merge.rs`, and `environment.rs`: create one definition context per operation and thread its config/definitions through every execution path.
- Modify Rust task-creator and HTTP test fixtures: publish test definitions to an `origin/*` tracking ref instead of depending on uncommitted local files.
- Create `crates/kanna-server/src/http_api/tests/repo_definitions.rs`: endpoint contract and stale-local/fresh-remote coverage.
- Modify `crates/kanna-server/src/http_api/repos.rs` and `router.rs`: server-owned definition endpoints.
- Modify `apps/desktop/src/services/desktopServerClient.ts`: typed endpoint clients and test seams.
- Modify `apps/desktop/src/stores/pipeline.ts` and `state.ts`: revision-aware definitions and repo-ID-based config loading.
- Modify desktop task creation, navigation, query, session, and teardown consumers so no orchestration read uses local `.kanna/config.json`, pipelines, or agents.

### Task 1: Git-backed immutable definition snapshot

**Files:**
- Create: `crates/kanna-server/src/task_creator/definition_source.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`

- [ ] **Step 1: Write failing snapshot-source tests**

Add tests at the bottom of `definition_source.rs` that create a bare origin, publisher clone, and consumer clone. The key assertions must use distinct sentinels:

```rust
#[test]
fn resolve_fetches_origin_and_ignores_local_default_branch() {
    let fixture = RemoteFixture::new("source-prefers-origin");
    fixture.publish("remote-v1");
    fixture.write_local("local-stale");

    let source = RepoDefinitionSnapshot::resolve(
        fixture.consumer().to_string_lossy().as_ref(),
        Some("main"),
    )
    .unwrap();

    assert_eq!(source.ref_name(), "origin/main");
    assert_eq!(source.read_optional_utf8(".kanna/config.json").unwrap().as_deref(), Some("remote-v1"));
    assert!(!source.revision().unwrap().is_empty());
}

#[test]
fn one_snapshot_stays_pinned_when_origin_advances() {
    let fixture = RemoteFixture::new("source-pinned");
    fixture.publish("remote-v1");
    let first = RepoDefinitionSnapshot::resolve(
        fixture.consumer().to_string_lossy().as_ref(),
        Some("main"),
    )
    .unwrap();

    fixture.publish("remote-v2");
    let second = RepoDefinitionSnapshot::resolve(
        fixture.consumer().to_string_lossy().as_ref(),
        Some("main"),
    )
    .unwrap();

    assert_eq!(first.read_optional_utf8(".kanna/config.json").unwrap().as_deref(), Some("remote-v1"));
    assert_eq!(second.read_optional_utf8(".kanna/config.json").unwrap().as_deref(), Some("remote-v2"));
    assert_ne!(first.revision(), second.revision());
}

#[test]
fn cached_remote_survives_fetch_failure_and_no_ref_is_bundled_only() {
    let fixture = RemoteFixture::new("source-offline");
    fixture.publish("cached-remote");
    fixture.fetch_consumer();
    fixture.disconnect_origin();

    let cached = RepoDefinitionSnapshot::resolve(
        fixture.consumer().to_string_lossy().as_ref(),
        Some("main"),
    )
    .unwrap();
    assert_eq!(cached.read_optional_utf8(".kanna/config.json").unwrap().as_deref(), Some("cached-remote"));

    let local_only = RemoteFixture::local_only("source-no-origin", "local-must-not-load");
    let bundled = RepoDefinitionSnapshot::resolve(
        local_only.to_string_lossy().as_ref(),
        Some("main"),
    )
    .unwrap();
    assert_eq!(bundled.revision(), None);
    assert_eq!(bundled.read_optional_utf8(".kanna/config.json").unwrap(), None);
}
```

The fixture must use `git init --bare`, `git init -b main`, `git remote add origin`, `git push origin main`, and `git clone`; it must retain its `TempDir` so paths remain alive.

- [ ] **Step 2: Run the source tests and verify RED**

Run:

```bash
cargo test -p kanna-server task_creator::definition_source::tests -- --nocapture
```

Expected: compilation fails because `RepoDefinitionSnapshot` and the module do not yet exist.

- [ ] **Step 3: Implement the minimal immutable source**

Register `mod definition_source;` and implement this API:

```rust
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub(crate) struct RepoDefinitionSnapshot {
    repo_path: PathBuf,
    ref_name: String,
    commit_id: Option<String>,
}

impl RepoDefinitionSnapshot {
    pub(crate) fn resolve(repo_path: &str, default_branch: Option<&str>) -> Result<Self, String> {
        let branch = default_branch.filter(|value| !value.trim().is_empty()).unwrap_or("main");
        let ref_name = format!("origin/{branch}");
        let fetch = Command::new("git").args(["fetch", "origin"]).current_dir(repo_path).output();
        if let Ok(output) = &fetch {
            if !output.status.success() {
                log::warn!("failed to refresh {ref_name}; using cached ref when available: {}", String::from_utf8_lossy(&output.stderr).trim());
            }
        } else if let Err(error) = &fetch {
            log::warn!("failed to run git fetch for {ref_name}: {error}");
        }

        let revision_arg = format!("refs/remotes/origin/{branch}^{{commit}}");
        let output = Command::new("git")
            .args(["rev-parse", "--verify", &revision_arg])
            .current_dir(repo_path)
            .output()
            .map_err(|error| format!("failed to resolve {ref_name}: {error}"))?;
        let commit_id = output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|revision| !revision.is_empty());

        Ok(Self { repo_path: PathBuf::from(repo_path), ref_name, commit_id })
    }

    pub(crate) fn revision(&self) -> Option<&str> { self.commit_id.as_deref() }
    pub(crate) fn ref_name(&self) -> &str { &self.ref_name }

    pub(crate) fn read_optional_utf8(&self, relative_path: &str) -> Result<Option<String>, String> {
        validate_relative_path(relative_path)?;
        let Some(commit) = self.commit_id.as_deref() else { return Ok(None); };
        let object = format!("{commit}:{relative_path}");
        let exists = Command::new("git").args(["cat-file", "-e", &object]).current_dir(&self.repo_path).status()
            .map_err(|error| format!("failed to inspect {object}: {error}"))?;
        if !exists.success() { return Ok(None); }
        let output = Command::new("git").args(["cat-file", "blob", &object]).current_dir(&self.repo_path).output()
            .map_err(|error| format!("failed to read {object}: {error}"))?;
        if !output.status.success() {
            return Err(format!("failed to read {object}: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        String::from_utf8(output.stdout)
            .map(Some)
            .map_err(|error| format!("definition {object} is not UTF-8: {error}"))
    }

    pub(crate) fn list_direct_entries(&self, relative_tree: &str) -> Result<Vec<String>, String> {
        validate_relative_path(relative_tree)?;
        let Some(commit) = self.commit_id.as_deref() else { return Ok(Vec::new()); };
        let tree = format!("{commit}:{relative_tree}");
        let exists = Command::new("git").args(["cat-file", "-e", &tree]).current_dir(&self.repo_path).status()
            .map_err(|error| format!("failed to inspect {tree}: {error}"))?;
        if !exists.success() { return Ok(Vec::new()); }
        let output = Command::new("git").args(["ls-tree", "--name-only", &tree]).current_dir(&self.repo_path).output()
            .map_err(|error| format!("failed to list {tree}: {error}"))?;
        if !output.status.success() {
            return Err(format!("failed to list {tree}: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let stdout = String::from_utf8(output.stdout).map_err(|error| format!("tree {tree} is not UTF-8: {error}"))?;
        Ok(stdout.lines().map(str::to_string).collect())
    }
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let valid = !path.is_empty() && Path::new(path).components().all(|component| matches!(component, Component::Normal(_)));
    if valid { Ok(()) } else { Err(format!("invalid definition path: {path}")) }
}
```

- [ ] **Step 4: Run source tests and verify GREEN**

Run the Task 1 command again. Expected: all snapshot tests pass, including fetch refresh, immutable commit pinning, cached offline ref, no-ref bundled-only behavior, path rejection, direct tree listing, and non-UTF-8 errors.

### Task 2: Source-aware config, pipeline, and agent definitions

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/mod.rs`

- [ ] **Step 1: Add a failing aggregate-loader regression test**

Create a remote fixture whose origin commit contains a complete config, custom pipeline, role override, and extension. After fetching, overwrite all four local files with `LOCAL_SENTINEL` without committing. Assert:

```rust
#[test]
fn repo_definitions_use_one_remote_snapshot_for_all_kanna_parameters() {
    let fixture = init_remote_definitions_fixture("all-remote-parameters");
    let repo = fixture.repo("dev");
    let definitions = RepoDefinitions::resolve(&repo).unwrap();

    assert_eq!(definitions.ref_name(), "origin/dev");
    assert_eq!(definitions.config().pipeline.as_deref(), Some("remote-qa"));
    assert_eq!(definitions.config().setup.as_deref(), Some(&["remote setup".to_string()][..]));
    assert_eq!(definitions.config().teardown.as_deref(), Some(&["remote teardown".to_string()][..]));
    assert_eq!(definitions.config().ports.as_ref().unwrap()["KANNA_DEV_PORT"], 1420);
    assert_eq!(definitions.config().flavors.as_ref().unwrap()["review"], "strict");
    assert_eq!(definitions.config().vars.as_ref().unwrap()["REVIEW_TEAM"], "remote-team");
    assert_eq!(definitions.config().reserved_ports, vec![48120]);
    assert_eq!(definitions.config().reserved_port_offsets, vec![1, 2]);
    assert_eq!(definitions.config().stage_order.as_deref(), Some(&["review".to_string(), "pr".to_string()][..]));
    assert_eq!(definitions.config().workspace.as_ref().unwrap().env.as_ref().unwrap()["REMOTE_ENV"], "yes");

    let pipeline = definitions.pipeline("remote-qa").unwrap();
    assert_eq!(pipeline.stages[0].prompt.as_deref(), Some("REMOTE_PIPELINE"));
    let agent = definitions.agent("review").unwrap();
    assert!(agent.prompt.contains("REMOTE_AGENT"));
    assert!(agent.prompt.contains("REMOTE_EXTENSION"));
    assert!(!agent.prompt.contains("LOCAL_SENTINEL"));
}
```

Also add tests that a missing remote resource uses compiled builtins, a malformed remote resource returns an error mentioning ref/revision/path, and a local-only custom definition is ignored.

- [ ] **Step 2: Run the aggregate test and verify RED**

Run:

```bash
cargo test -p kanna-server repo_definitions_use_one_remote_snapshot_for_all_kanna_parameters -- --nocapture
```

Expected: compilation fails because `RepoDefinitions` does not exist.

- [ ] **Step 3: Implement `RepoDefinitions` and complete wire-compatible models**

Refactor `definitions.rs` around:

```rust
pub(crate) struct RepoDefinitions {
    snapshot: RepoDefinitionSnapshot,
    config: RepoConfig,
}

impl RepoDefinitions {
    pub(crate) fn resolve(repo: &Repo) -> Result<Self, String> {
        let snapshot = RepoDefinitionSnapshot::resolve(&repo.path, repo.default_branch.as_deref())?;
        let config = read_repo_config(&snapshot)?;
        Ok(Self { snapshot, config })
    }

    pub(crate) fn revision(&self) -> Option<&str> { self.snapshot.revision() }
    pub(crate) fn ref_name(&self) -> &str { self.snapshot.ref_name() }
    pub(crate) fn config(&self) -> &RepoConfig { &self.config }
    pub(crate) fn pipeline(&self, name: &str) -> Result<PipelineDefinition, String> {
        read_pipeline_definition(&self.snapshot, name)
    }
    pub(crate) fn task_pipeline(&self, name: &str, stored: Option<&str>) -> Result<PipelineDefinition, String> {
        read_task_pipeline_definition(&self.snapshot, name, stored)
    }
    pub(crate) fn agent(&self, selector: &str) -> Result<AgentDefinition, String> {
        read_agent_definition(&self.snapshot, &self.config, selector)
    }
    pub(crate) fn pipeline_names(&self) -> Result<Vec<String>, String> {
        let mut names = self.snapshot.list_direct_entries(".kanna/pipelines")?
            .into_iter()
            .filter(|name| name.ends_with(".json") && name != "schema.json")
            .map(|name| name.trim_end_matches(".json").to_string())
            .chain(["default".to_string(), "qa".to_string()])
            .collect::<Vec<_>>();
        names.sort();
        names.dedup();
        Ok(names)
    }
}
```

Change the resource readers to `snapshot.read_optional_utf8(...)`. Only `Ok(None)` may fall back to `compiled_builtin_resource`; `Err` must propagate. Remove the current-directory ancestor scan from `read_builtin_resource` so bundled-only mode cannot accidentally read a checkout.

Derive `Clone`, `Deserialize`, and `Serialize` for `RepoConfig` and nested types. Add the fields already supported by TypeScript but currently discarded by Rust:

```rust
pub(super) test: Option<Vec<String>>,
pub(super) stage_order: Option<Vec<String>>,
pub(super) env: Option<HashMap<String, String>>, // on RepoWorkspaceConfig
```

Extend agent parsing with `name` and `description`, serialize `agent_providers` as `agent_provider`, and allow an extension description to override the base. Preserve schema snake_case for `agent_provider`, `permission_mode`, and `allowed_tools`.

Extend normalized pipeline/stage/post types with optional descriptions and provide API DTO conversion that omits absent values and fills a missing pipeline name from the requested filename. Do not change stored pipeline semantics.

- [ ] **Step 4: Make fixture definitions committed and remotely addressable**

In `task_creator/tests/mod.rs`, add:

```rust
fn publish_origin_main(repo_root: &std::path::Path, message: &str) {
    assert!(Command::new("git").args(["add", "."]).current_dir(repo_root).status().unwrap().success());
    let _ = Command::new("git").args(["commit", "-m", message]).current_dir(repo_root).status().unwrap();
    let head = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(repo_root).output().unwrap();
    let head = String::from_utf8(head.stdout).unwrap();
    assert!(Command::new("git")
        .args(["update-ref", "refs/remotes/origin/main", head.trim()])
        .current_dir(repo_root)
        .status().unwrap().success());
}
```

Call it from `init_git_repo*` after the initial commit and after helper-created pipeline commits. Direct parser tests may construct a snapshot at the cached ref; orchestration tests that add definitions later must publish them explicitly.

- [ ] **Step 5: Run definition and parser tests**

Run:

```bash
cargo test -p kanna-server task_creator::tests::core -- --nocapture
```

Expected: all existing parser/flavor/extension tests and the new remote-source tests pass.

### Task 3: Thread one remote definition context through every orchestration operation

**Files:**
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/prompt.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/merge.rs`
- Modify: `crates/kanna-server/src/task_creator/environment.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/setup.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/spawn.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] **Step 1: Add failing task-creation and stage-transition regressions**

Add a creation test where local and remote definitions disagree, then assert the prepared task uses the remote pipeline snapshot, agent body, model, permission mode, tools, config vars, port base, setup command, workspace env, and PATH entry. Add a stage test that advances origin after a `RepoDefinitions` context is created and proves prompt, spawn, and teardown within that operation all use its original revision.

The creation assertions should include:

```rust
assert_eq!(stored.pipeline.as_deref(), Some("remote-qa"));
assert!(stored.pipeline_def.as_deref().unwrap().contains("REMOTE_PIPELINE"));
assert!(runtime_prompt(&prepared).contains("REMOTE_AGENT remote-team"));
assert_eq!(prepared.model.as_deref(), Some("remote-model"));
assert_eq!(prepared.env.get("REMOTE_ENV").map(String::as_str), Some("yes"));
assert!(prepared.env.get("PATH").unwrap().starts_with(&format!("{}/remote-bin:", prepared.cwd)));
assert!(!runtime_prompt(&prepared).contains("LOCAL_SENTINEL"));
```

- [ ] **Step 2: Run the new orchestration tests and verify RED**

Run:

```bash
cargo test -p kanna-server remote_definition -- --nocapture
```

Expected: assertions expose current local/worktree config and agent reads.

- [ ] **Step 3: Thread `RepoDefinitions` through task creation and dormant/reopen flows**

Create one context in each top-level operation and replace repeated path reads in:

- `resolve_available_agent_providers(&Repo)`;
- `create_dormant_task_for_api`;
- `prepare_start_dormant_task_for_api`;
- `prepare_task_spawn` and `resolve_task_spawn`;
- `prepare_rerun_stage_for_api`;
- `reopen_task_for_api`;
- `prepare_new_task_session`.

Use these signatures:

```rust
fn resolve_task_spawn(
    repo: &Repo,
    request: TaskCreationRequest,
    definitions: &RepoDefinitions,
) -> Result<ResolvedTaskSpawn, String>;

fn prepare_new_task_session(
    config: &Config,
    task_id: &str,
    worktree_path: &str,
    port_env: &HashMap<String, String>,
    repo_config: &RepoConfig,
    resolved: &ResolvedTaskSpawn,
) -> Result<PreparedNewTaskSession, String>;
```

Delete all worktree/root rereads. Relative workspace PATH entries still resolve against the actual task worktree path.

- [ ] **Step 4: Thread the context through stages, prompts, revisions, and teardown**

Add `definitions: &'a RepoDefinitions` to `StageTransitionContext`. `load_stage_transition_source` resolves it once, uses `definitions.task_pipeline(...)`, and returns it with the source context.

Change the core signatures to:

```rust
pub(super) fn build_target_stage_prompt(
    definitions: &RepoDefinitions,
    repo_path: &str,
    stage: &PipelineStage,
    task_prompt: &str,
    prev_result: Option<&str>,
    branch: Option<&str>,
    base_ref: Option<&str>,
    source_worktree_branch: Option<&str>,
) -> Result<String, String>;

pub(in crate::task_creator) fn prepare_stage_run_spawn(
    db: &Db,
    config: &Config,
    repo: &Repo,
    definitions: &RepoDefinitions,
    task_id: &str,
    pipeline_name: &str,
    pipeline: &PipelineDefinition,
    target_stage: &PipelineStage,
    item_stage: &str,
    run_kind: &'static str,
    workspace_spec: RunWorkspaceSpec,
    final_prompt: String,
    branch: &str,
    feedback: Option<String>,
    source_agent_type: Option<&str>,
    explicit_provider: Option<String>,
    fallback_provider: Option<&str>,
) -> Result<PreparedStageRunSpawn, String>;
```

Use `definitions.config()` for ports, setup, teardown, provider PATH, prompt vars, workspace env, and relative PATH resolution. `prepare_workspace_teardown_for_close` may create its own single context because close is a separate operation; `prepare_workspace_teardown` receives the caller's context. Log definition/config errors before retaining close's current best-effort `Option` behavior.

Remove merge-agent prevalidation from `build_merge_task_request`; `prepare_task_spawn` performs the one authoritative resolution.

Change `resolve_stage_transition` and `mobile_api::map_task_detail` to use the task's stored `pipeline_def` first, then a `RepoDefinitions` fallback only for legacy rows without a snapshot.

- [ ] **Step 5: Apply every workspace config field in Rust**

Rename `apply_workspace_path_env` to `apply_workspace_config_env` and apply `workspace.env` before constructing PATH:

```rust
pub(super) fn apply_workspace_config_env(
    env: &mut HashMap<String, String>,
    worktree_path: &str,
    repo_config: &RepoConfig,
) {
    let Some(workspace) = repo_config.workspace.as_ref() else { return; };
    if let Some(config_env) = workspace.env.as_ref() {
        env.extend(config_env.clone());
    }
    let Some(path_config) = workspace.path.as_ref() else { return; };
    let prepend_entries = path_config
        .prepend
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let append_entries = path_config
        .append
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let existing_path = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let path_parts = prepend_entries
        .chain(std::iter::once(existing_path).filter(|entry| !entry.is_empty()))
        .chain(append_entries)
        .collect::<Vec<_>>();
    if !path_parts.is_empty() {
        env.insert("PATH".to_string(), path_parts.join(":"));
    }
}
```

Update `build_workspace_search_path` and all callers to use the renamed function.

- [ ] **Step 6: Publish all test definitions before orchestration reads**

In `core.rs`, `setup.rs`, `spawn.rs`, `stage.rs`, and `revision.rs`, call `publish_origin_main` after fixture-specific `.kanna` writes. Do not add a `cfg(test)` production fallback to local files. Tests that intentionally exercise bundled-only behavior must omit `refs/remotes/origin/main` explicitly.

- [ ] **Step 7: Run the complete task-creator suite**

Run:

```bash
cargo test -p kanna-server task_creator::tests -- --nocapture
```

Expected: all creation, setup, spawn, stage, revision, rerun, merge, close, and teardown tests pass without local-definition reads.

### Task 4: Server-owned revisioned definition HTTP API

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/http_api/repos.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/tests.rs`
- Create: `crates/kanna-server/src/http_api/tests/repo_definitions.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`

- [ ] **Step 1: Write failing route-contract tests**

Cover the three approved routes using a stale-local/fresh-remote fixture:

```rust
#[tokio::test]
async fn repo_definition_routes_return_remote_revision_and_normalized_definitions() {
    let fixture = HttpRemoteDefinitionsFixture::new("repo-definition-routes", "dev");
    let app = fixture.router();

    let manifest = get_json(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(manifest["refName"], "origin/dev");
    assert_eq!(manifest["config"]["vars"]["SOURCE"], "remote");
    assert_eq!(manifest["defaultPipeline"], "remote-qa");
    assert_eq!(manifest["pipelines"], serde_json::json!(["default", "qa", "remote-qa"]));

    let pipeline = get_json(&app, "/v1/repos/repo-1/kanna-definitions/pipelines/remote-qa").await;
    assert_eq!(pipeline["definition"]["stages"][0]["prompt"], "REMOTE_PIPELINE");

    let agent = get_json(&app, "/v1/repos/repo-1/kanna-definitions/agents/review%40strict").await;
    assert_eq!(agent["definition"]["agent_provider"], serde_json::json!(["codex", "claude"]));
    assert!(agent["definition"]["prompt"].as_str().unwrap().contains("REMOTE_EXTENSION"));
}
```

Also assert: bundled-only `revision: null`; `schema.json` excluded; names sorted/deduped; invalid decoded traversal is 400; unknown repo/definition is 404; malformed remote definition is 500; outer keys are camelCase while inner definition keys are snake_case.

- [ ] **Step 2: Run route tests and verify RED**

Run:

```bash
cargo test -p kanna-server http_api::tests::repo_definitions -- --nocapture
```

Expected: 404 because the routes do not exist.

- [ ] **Step 3: Add the task-creator API facade and safe lookup results**

Expose narrow `pub(crate)` DTO/functions from `task_creator`, not the private parser module:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoKannaDefinitions {
    revision: Option<String>,
    ref_name: String,
    config: RepoConfig,
    default_pipeline: String,
    pipelines: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionedDefinition<T> {
    revision: Option<String>,
    definition: T,
}
```

Add functions returning a typed `DefinitionLookupError::{InvalidName, NotFound, Other}` so HTTP status mapping never parses error strings. Validate pipeline names as one safe direct component and agent selectors as `role` or `role@flavor`, with each part nonempty and free of `/`, `\\`, `.`, `..`, control, or NUL characters.

- [ ] **Step 4: Implement handlers and routes**

Add handlers in `repos.rs` that follow `list_available_agent_providers` for DB lookup and map errors to 400/404/500. Register:

```rust
.route("/v1/repos/{repo_id}/kanna-definitions", get(get_repo_kanna_definitions))
.route("/v1/repos/{repo_id}/kanna-definitions/pipelines/{pipeline_name}", get(get_repo_pipeline_definition))
.route("/v1/repos/{repo_id}/kanna-definitions/agents/{agent_selector}", get(get_repo_agent_definition))
```

Change `list_available_agent_providers` to pass `&Repo` so its workspace PATH configuration is remote-backed too.

- [ ] **Step 5: Run route tests and the server crate**

Run:

```bash
cargo test -p kanna-server http_api::tests::repo_definitions -- --nocapture
cargo test -p kanna-server
```

Expected: all route contracts and existing server tests pass.

### Task 5: Typed desktop clients for the server definition API

**Files:**
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.test.ts`

- [ ] **Step 1: Write failing client endpoint tests**

Add tests that return representative manifest/pipeline/agent JSON and assert separately encoded path segments:

```typescript
await expect(fetchDesktopRepoKannaDefinitions("repo/with space")).resolves.toMatchObject({
  revision: "abc123",
  refName: "origin/main",
  defaultPipeline: "qa",
  pipelines: ["default", "qa"],
});
expect(fetchMock).toHaveBeenCalledWith(
  "http://127.0.0.1:48121/v1/repos/repo%2Fwith%20space/kanna-definitions",
  expect.objectContaining({ method: "GET" }),
);

await fetchDesktopRepoPipelineDefinition("repo/one", "qa candidate");
expect(fetchMock).toHaveBeenLastCalledWith(
  "http://127.0.0.1:48121/v1/repos/repo%2Fone/kanna-definitions/pipelines/qa%20candidate",
  expect.anything(),
);

await fetchDesktopRepoAgentDefinition("repo/one", "review@strict");
expect(fetchMock).toHaveBeenLastCalledWith(
  "http://127.0.0.1:48121/v1/repos/repo%2Fone/kanna-definitions/agents/review%40strict",
  expect.anything(),
);
```

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/services/desktopServerClient.test.ts
```

Expected: imports fail because the new client functions do not exist.

- [ ] **Step 3: Implement typed clients and test seams**

Add:

```typescript
export interface DesktopRepoKannaDefinitions {
  revision: string | null;
  refName: string;
  config: RepoConfig;
  defaultPipeline: string;
  pipelines: string[];
}

export interface DesktopRepoPipelineDefinition {
  revision: string | null;
  definition: PipelineDefinition;
}

export interface DesktopRepoAgentDefinition {
  revision: string | null;
  definition: AgentDefinition;
}
```

Add matching `DesktopServerClientHandlersForTests` callbacks and fetch functions using `requestJson`, applying `encodeURIComponent` to every dynamic segment independently.

- [ ] **Step 4: Run client tests and verify GREEN**

Run the Task 5 command again. Expected: endpoint, casing, encoding, and test-handler override tests pass.

### Task 6: Replace desktop pipeline/agent filesystem loaders with revisioned server definitions

**Files:**
- Modify: `apps/desktop/src/stores/pipeline.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/stores/pipelineAgentExtension.test.ts`
- Modify: `apps/desktop/src/stores/pipeline.selection.test.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Replace filesystem-loader tests with failing server-resolution tests**

In `pipelineAgentExtension.test.ts`, inject `fetchRepoAgentDefinition` and assert repo-ID routing, revision replacement, object reuse for equal revisions, and error propagation:

```typescript
const first = { revision: "rev-1", definition: remoteAgent("REMOTE_AGENT") };
const second = { revision: "rev-2", definition: remoteAgent("REMOTE_AGENT_V2") };
const fetchRepoAgentDefinition = vi.fn()
  .mockResolvedValueOnce(first)
  .mockResolvedValueOnce(first)
  .mockResolvedValueOnce(second);
updateDesktopServerClientHandlersForTests({ fetchRepoAgentDefinition });

const api = makeApi();
const one = await api.loadAgent("repo-1", "review");
const same = await api.loadAgent("repo-1", "review");
const changed = await api.loadAgent("repo-1", "review");

expect(fetchRepoAgentDefinition).toHaveBeenCalledWith("repo-1", "review");
expect(same).toBe(one);
expect(changed).not.toBe(one);
expect(changed.prompt).toBe("REMOTE_AGENT_V2");
expect(invokeMock).not.toHaveBeenCalledWith("read_text_file", expect.anything());
```

Update selection tests to inject `fetchRepoPipelineDefinition` instead of seeding a path-only cache.

- [ ] **Step 2: Run focused store tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/stores/pipelineAgentExtension.test.ts \
  src/stores/pipeline.selection.test.ts
```

Expected: current functions treat the first argument as a path and call local filesystem invokes.

- [ ] **Step 3: Implement repo-ID, revision-aware store loading**

Change `PipelineApi` and `StoreServices` to:

```typescript
loadPipeline: (repoId: string, pipelineName: string) => Promise<PipelineDefinition>;
loadAgent: (repoId: string, agentName: string) => Promise<AgentDefinition>;
```

Change cache value types to:

```typescript
interface RevisionedCacheEntry<T> {
  revision: string | null;
  definition: T;
}
pipelineCache: Map<string, RevisionedCacheEntry<PipelineDefinition>>;
agentCache: Map<string, RevisionedCacheEntry<AgentDefinition>>;
```

Each load calls the server endpoint so it can observe a new revision, returns the cached object when `cached.revision === response.revision`, and otherwise replaces the entry. Remove `parseRepoConfig`, local/builtin parsers, selector logic, and all definition `invoke` reads from `pipeline.ts`.

Pass `item.repo_id` in optimistic stage projection. Pass `repo.id` from `mergeQueue`, custom-task launch, config-factory launch, and setup launch call sites in `kanna.ts` and `useAppTaskNavigation.ts`.

- [ ] **Step 4: Run store and integration tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/stores/pipelineAgentExtension.test.ts \
  src/stores/pipeline.selection.test.ts \
  src/stores/kanna.taskBaseBranch.test.ts \
  src/App.test.ts
```

Expected: all server-resolution, cache-revision, merge-agent, setup-agent, and optimistic-selection tests pass.

### Task 7: Move pipeline discovery and every live desktop repo-config consumer to the manifest

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/taskLifecycleEnv.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/kannaConfig.test.ts`
- Modify: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Modify: `apps/desktop/src/stores/sessions.test.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Write failing modal and config-consumer tests**

Inject a manifest with remote-only values:

```typescript
const manifest = {
  revision: "remote-rev",
  refName: "origin/main",
  config: {
    pipeline: "remote-qa",
    stage_order: ["review", "pr"],
    setup: ["remote setup"],
    teardown: ["remote teardown"],
    workspace: { env: { REMOTE_ENV: "yes" }, path: { prepend: ["remote-bin"] } },
  },
  defaultPipeline: "remote-qa",
  pipelines: ["default", "remote-qa"],
};
updateDesktopServerClientHandlersForTests({ fetchRepoKannaDefinitions: async () => manifest });
```

Assert:

- `openNewTaskModal` displays `manifest.pipelines/defaultPipeline` and never invokes `list_dir` or `read_text_file` for definitions;
- snapshot reload uses `stage_order` from the manifest;
- recovered agent sessions and worktree shells receive `REMOTE_ENV` and a worktree-relative `remote-bin` PATH;
- repo teardown uses `manifest.config.teardown` while custom task-template teardown remains local;
- manifest errors propagate and never trigger a local fallback.

- [ ] **Step 2: Run focused config-consumer tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/composables/useAppTaskCreation.test.ts \
  src/stores/kannaConfig.test.ts \
  src/stores/kanna.querySnapshot.test.ts \
  src/stores/sessions.test.ts
```

Expected: tests show local `.kanna/config.json` and pipeline-directory reads.

- [ ] **Step 3: Load modal pipeline choices from the manifest**

In `openNewTaskModal`, fetch `fetchDesktopRepoKannaDefinitions(targetRepo.id)` before provider discovery. Set:

```typescript
availablePipelines.value = manifest.pipelines;
defaultPipelineName.value = manifest.defaultPipeline;
```

Retain Git base-branch discovery. Keep cloud-only repos empty until they are cloned/imported. On import/setup, call `store.loadAgent(repoId, "setup")`.

- [ ] **Step 4: Replace `readRepoConfig(basePath)` with a repo-ID manifest helper**

In `state.ts`:

```typescript
export async function fetchRepoConfig(repoId: string): Promise<RepoConfig> {
  return (await fetchDesktopRepoKannaDefinitions(repoId)).config;
}
```

Remove local parsing, missing-file heuristics, and definition filesystem invokes. Use `repo.id` in `queries.ts` stage-order loading and key stage-order cache entries by repo ID plus manifest revision so a changed revision replaces the ordering.

- [ ] **Step 5: Use remote config for shells, recovery, setup, and teardown**

In `sessions.ts`, resolve the task and repo ID from store state before calling `fetchRepoConfig`. Keep public session method signatures unchanged. If a generic non-task shell has no repo/task identity, use `{}`; never infer config by reading its cwd.

In `taskLifecycleEnv.ts`, use `fetchRepoConfig(repo.id)` for repo teardown. Leave `.kanna/tasks/*/agent.md` custom-template discovery local per the design's non-goal.

Remove obsolete `readRepoConfig` exports/imports and local definition parser mocks.

- [ ] **Step 6: Run the desktop focused suite and typecheck**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/services/desktopServerClient.test.ts \
  src/composables/useAppTaskCreation.test.ts \
  src/stores/pipelineAgentExtension.test.ts \
  src/stores/pipeline.selection.test.ts \
  src/stores/kanna.querySnapshot.test.ts \
  src/stores/sessions.test.ts \
  src/stores/kannaConfig.test.ts \
  src/stores/kanna.taskBaseBranch.test.ts \
  src/stores/kanna.runtimeStatusSync.test.ts \
  src/App.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: all focused tests and typecheck pass with no direct orchestration definition reads.

### Task 8: Static audit and full verification

**Files:**
- Modify only files required by failures introduced by Tasks 1-7.

- [ ] **Step 1: Audit for forbidden live local definition reads**

Run:

```bash
rg -n --glob '!**/*.test.*' --glob '!**/fixtures/**' \
  '\.kanna/(config\.json|pipelines|agents)' \
  apps/desktop/src crates/kanna-server/src/task_creator
```

Expected: no live filesystem readers remain for config/pipelines/agents. Allowed hits are user-facing prompt text, compiled `include_str!` resources, comments, and intentionally local `.kanna/tasks` discovery.

- [ ] **Step 2: Run formatting and diff checks**

Run:

```bash
cargo fmt --all -- --check
git diff --check
```

If formatting fails, run `cargo fmt --all`, then repeat both checks.

- [ ] **Step 3: Run canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: all Rust workspace tests pass.

- [ ] **Step 4: Run desktop and monorepo verification**

Run:

```bash
pnpm --dir apps/desktop test
pnpm test
```

Expected: desktop and monorepo test suites pass.

- [ ] **Step 5: Review the final diff without committing**

Run:

```bash
git status --short
git diff --stat
git diff -- docs/superpowers/specs/2026-07-15-origin-default-kanna-definitions-design.md \
  docs/superpowers/plans/2026-07-15-origin-default-kanna-definitions.md
```

Confirm the diff contains only this task's implementation, tests, and design/plan documents. Leave all changes uncommitted for the pipeline's commit stage.
