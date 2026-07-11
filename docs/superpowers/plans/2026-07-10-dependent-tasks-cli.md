# Dependent Tasks CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kanna-cli task dependent-tasks-exist --task-id <ID> [--server-url <URL>]` and restore exact typed-CLI/tool-catalog parity.

**Architecture:** Mirror the existing server response in typed CLI models, add a percent-encoding path helper and typed GET client, then expose it through `TaskCommands`. Keep the existing MCP tool name, catalog entry, and HTTP route unchanged.

**Tech Stack:** Rust, Clap 4, Reqwest, Serde, Tokio tests, Vitest.

---

### Task 1: Add the Typed HTTP Boundary

**Files:**
- Modify: `crates/kanna-cli/src/models.rs`
- Modify: `crates/kanna-cli/src/api.rs`
- Modify: `crates/kanna-cli/src/tests/mod.rs`
- Test: `crates/kanna-cli/src/tests/api_paths.rs`
- Test: `crates/kanna-cli/src/tests/http_api.rs`

- [ ] **Step 1: Reproduce the existing contract failure**

Run:

```bash
cargo test -p kanna-cli typed_cli_surfaces_match_catalog_tools_and_params -- --nocapture
```

Expected: FAIL because `kanna_is_dependent_tasks_exist` exists only on the catalog side.

- [ ] **Step 2: Add failing path and HTTP tests**

Add `dependent_tasks_exist_path` and `dependent_tasks_exist_via_api` to the `crate::api` imports in `crates/kanna-cli/src/tests/mod.rs`.

Add to `crates/kanna-cli/src/tests/api_paths.rs`:

```rust
#[test]
fn dependent_tasks_exist_path_encodes_task_id() {
    assert_eq!(
        dependent_tasks_exist_path("task 1"),
        "/v1/tasks/task%201/dependent-tasks-exist"
    );
}
```

Add to `crates/kanna-cli/src/tests/http_api.rs`:

```rust
#[tokio::test]
async fn dependent_tasks_exist_via_api_gets_and_decodes_response() {
    let response = http_json_response(
        "200 OK",
        r#"{
            "exists": true,
            "dependentTasks": [{
                "taskId": "dependent-1",
                "title": "Dependent task",
                "branch": "feature/child",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }]
        }"#,
    );
    let (base_url, handle) = serve_single_http_response(response).await;

    let result = dependent_tasks_exist_via_api(&base_url, "task-123")
        .await
        .unwrap();
    let request = handle.await.unwrap();

    assert!(result.exists);
    assert_eq!(result.dependent_tasks[0].task_id, "dependent-1");
    assert_eq!(result.dependent_tasks[0].reason, "base_ref");
    assert!(request.starts_with(
        "GET /v1/tasks/task-123/dependent-tasks-exist HTTP/1.1"
    ));
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({
            "exists": true,
            "dependentTasks": [{
                "taskId": "dependent-1",
                "title": "Dependent task",
                "branch": "feature/child",
                "baseRef": "origin/feature/parent",
                "reason": "base_ref"
            }]
        })
    );
}
```

- [ ] **Step 3: Verify the new tests are red**

Run:

```bash
cargo test -p kanna-cli dependent_tasks_exist -- --nocapture
```

Expected: compilation fails with unresolved imports for the new API functions.

- [ ] **Step 4: Add response models**

Add to `crates/kanna-cli/src/models.rs`:

```rust
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DependentTaskInfo {
    pub(crate) task_id: String,
    pub(crate) title: String,
    pub(crate) branch: Option<String>,
    pub(crate) base_ref: Option<String>,
    pub(crate) reason: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DependentTasksExistResponse {
    pub(crate) exists: bool,
    pub(crate) dependent_tasks: Vec<DependentTaskInfo>,
}
```

Keep `reason` open as a `String` so a server-side reason addition does not require a CLI release.

- [ ] **Step 5: Add the path helper and API client**

Import `DependentTasksExistResponse` in `crates/kanna-cli/src/api.rs`, then add:

```rust
pub(crate) fn dependent_tasks_exist_path(task_id: &str) -> String {
    format!("{}/dependent-tasks-exist", task_get_path(task_id))
}

pub(crate) async fn dependent_tasks_exist_via_api(
    base_url: &str,
    task_id: &str,
) -> Result<DependentTasksExistResponse, String> {
    get_json(base_url, &dependent_tasks_exist_path(task_id)).await
}
```

- [ ] **Step 6: Verify the HTTP boundary is green**

Run:

```bash
cargo test -p kanna-cli dependent_tasks_exist -- --nocapture
```

Expected: the path and HTTP tests PASS.

### Task 2: Add the Typed Command Surface

**Files:**
- Modify: `crates/kanna-cli/src/main.rs`
- Modify: `crates/kanna-cli/src/commands/task.rs`
- Modify: `crates/kanna-cli/src/tests/mod.rs`
- Test: `crates/kanna-cli/src/tests/cli_surface.rs`

- [ ] **Step 1: Declare the failing catalog mapping**

Add to `typed_tool_surfaces()` in `crates/kanna-cli/src/tests/mod.rs`:

```rust
(
    "kanna_is_dependent_tasks_exist",
    TypedToolSurface {
        command_path: &["task", "dependent-tasks-exist"],
        param_args: &[("task_id", "task_id")],
    },
),
```

Add parser coverage to `crates/kanna-cli/src/tests/cli_surface.rs`:

```rust
#[test]
fn parses_dependent_tasks_exist_subcommand() {
    let matches = crate::Cli::command()
        .try_get_matches_from([
            "kanna-cli",
            "task",
            "dependent-tasks-exist",
            "--task-id",
            "task-1",
            "--server-url",
            "http://127.0.0.1:48120",
        ])
        .unwrap();

    let command = matches
        .subcommand_matches("task").unwrap()
        .subcommand_matches("dependent-tasks-exist").unwrap();
    assert_eq!(command.get_one::<String>("task_id").map(String::as_str), Some("task-1"));
    assert_eq!(
        command.get_one::<String>("server_url").map(String::as_str),
        Some("http://127.0.0.1:48120")
    );
}

#[test]
fn dependent_tasks_exist_requires_task_id() {
    let error = crate::Cli::command()
        .try_get_matches_from(["kanna-cli", "task", "dependent-tasks-exist"])
        .unwrap_err();
    assert_eq!(error.kind(), clap::error::ErrorKind::MissingRequiredArgument);
    assert!(error.to_string().contains("--task-id"));
}
```

- [ ] **Step 2: Verify the CLI tests are red**

Run:

```bash
cargo test -p kanna-cli tests::cli_surface -- --nocapture
```

Expected: the command is unknown and the parity test still reports the missing typed command.

- [ ] **Step 3: Add the Clap command**

Add to `TaskCommands` in `crates/kanna-cli/src/main.rs`:

```rust
/// Check whether open tasks still depend on a task's branch
DependentTasksExist {
    /// Task whose branch may still have dependent tasks
    #[arg(long)]
    task_id: String,

    /// Override the local Kanna server base URL
    #[arg(long)]
    server_url: Option<String>,
},
```

- [ ] **Step 4: Wire command execution**

Import `dependent_tasks_exist_via_api` in `crates/kanna-cli/src/commands/task.rs`, then add:

```rust
TaskCommands::DependentTasksExist { task_id, server_url } => {
    let base_url = resolve_server_base_url_from_env(server_url.as_deref());
    let response = dependent_tasks_exist_via_api(&base_url, &task_id)
        .await
        .unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            process::exit(1);
        });
    if let Err(error) = print_json(&response) {
        eprintln!("Error: {error}");
        process::exit(1);
    }
}
```

- [ ] **Step 5: Verify the CLI is green**

Run:

```bash
cargo test -p kanna-cli
cargo fmt -p kanna-cli -- --check
cargo clippy -p kanna-cli --all-targets -- -D warnings
```

Expected: all CLI tests pass, including the original parity contract; formatting and Clippy are clean.

- [ ] **Step 6: Commit the typed command**

```bash
git add crates/kanna-cli/src
git commit -m "feat: add dependent task check CLI command"
```

### Task 3: Update the Merge-Agent Fallback

**Files:**
- Modify: `.kanna/agents/merge/AGENT.md`
- Test: `packages/core/src/pipeline/qa-assets.test.ts`

- [ ] **Step 1: Tighten the documentation contract**

Add to the merge-agent test:

```ts
expect(mergeAgent).toContain(
  'If MCP is unavailable, use `kanna-cli task dependent-tasks-exist --task-id "<task_id>"`',
);
expect(mergeAgent).not.toContain("If MCP is unavailable, use `curl ");
```

- [ ] **Step 2: Verify the contract is red**

Run:

```bash
pnpm --dir packages/core exec vitest run src/pipeline/qa-assets.test.ts
```

Expected: FAIL because the merge agent still recommends raw `curl`.

- [ ] **Step 3: Replace the fallback instruction**

Change the relevant sentence in `.kanna/agents/merge/AGENT.md` to:

```markdown
If MCP is unavailable, use `kanna-cli task dependent-tasks-exist --task-id "<task_id>"`.
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --dir packages/core test
cargo test -p kanna-tool-catalog
cargo test -p kanna-server dependent_tasks_exist -- --nocapture
git diff --check
```

Expected: all targeted tests and whitespace checks pass.

```bash
git add .kanna/agents/merge/AGENT.md packages/core/src/pipeline/qa-assets.test.ts
git commit -m "docs: use typed CLI for dependent task checks"
```
