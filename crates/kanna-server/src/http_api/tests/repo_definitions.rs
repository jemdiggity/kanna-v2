use super::*;
use crate::db::NewRepo;
use serde_json::{json, Value};
use tempfile::TempDir;

struct RemoteDefinitionsFixture {
    _temp: TempDir,
    publisher: PathBuf,
    consumer: PathBuf,
    branch: String,
    revision: String,
}

impl RemoteDefinitionsFixture {
    fn new(name: &str, branch: &str) -> Self {
        let temp = tempfile::Builder::new()
            .prefix(&format!("kanna-http-definitions-{name}-"))
            .tempdir()
            .unwrap();
        let origin = temp.path().join("origin.git");
        let publisher = temp.path().join("publisher");
        let consumer = temp.path().join("consumer");
        std::fs::create_dir_all(&publisher).unwrap();
        run_git(temp.path(), &["init", "--bare", origin.to_str().unwrap()]);
        run_git(&publisher, &["init", "--initial-branch", branch]);
        run_git(&publisher, &["config", "user.email", "test@example.com"]);
        run_git(&publisher, &["config", "user.name", "Kanna Test"]);
        write_remote_definitions(&publisher);
        run_git(&publisher, &["add", "."]);
        run_git(&publisher, &["commit", "-m", "publish remote definitions"]);
        run_git(
            &publisher,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        run_git(&publisher, &["push", "-u", "origin", branch]);
        run_git(
            temp.path(),
            &[
                "clone",
                "--branch",
                branch,
                origin.to_str().unwrap(),
                consumer.to_str().unwrap(),
            ],
        );
        let revision = git_stdout(&publisher, &["rev-parse", "HEAD"]);

        // These dirty checkout values must never leak into the API response.
        std::fs::write(
            consumer.join(".kanna/config.json"),
            json!({"workflow": "local-stale", "vars": {"SOURCE": "local-stale"}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            consumer.join(".kanna/workflows/remote-qa.json"),
            json!({
                "name": "local-stale",
                "stages": [{
                    "name": "local",
                    "prompt": "LOCAL_STALE_WORKFLOW",
                    "policy": {"transition": "manual"}
                }]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            consumer.join(".kanna/agents/review/EXTEND.md"),
            "LOCAL_STALE_EXTENSION",
        )
        .unwrap();

        Self {
            _temp: temp,
            publisher,
            consumer,
            branch: branch.to_string(),
            revision,
        }
    }

    fn router(&self, repo_id: &str) -> axum::Router {
        let repo_path = self.consumer.to_string_lossy().to_string();
        let branch = self.branch.clone();
        super::test_router_with_seed("definitions", "Studio Mac", move |db| {
            db.insert_repo(NewRepo {
                id: repo_id,
                path: &repo_path,
                name: "Definitions Repo",
                default_branch: Some(&branch),
            })
            .unwrap();
        })
    }

    fn publish_malformed_workflow(&mut self, name: &str) {
        std::fs::write(
            self.publisher.join(format!(".kanna/workflows/{name}.json")),
            "{not valid json",
        )
        .unwrap();
        run_git(&self.publisher, &["add", ".kanna"]);
        run_git(
            &self.publisher,
            &["commit", "-m", "publish malformed workflow"],
        );
        run_git(&self.publisher, &["push", "origin", &self.branch]);
        self.revision = git_stdout(&self.publisher, &["rev-parse", "HEAD"]);
    }

    fn publish_workflow_prompt(&mut self, prompt: &str) {
        std::fs::write(
            self.publisher.join(".kanna/workflows/remote-qa.json"),
            json!({
                "stages": [{
                    "name": "review",
                    "agent": "review@strict",
                    "prompt": prompt,
                    "policy": {"transition": "manual"}
                }]
            })
            .to_string(),
        )
        .unwrap();
        run_git(&self.publisher, &["add", ".kanna"]);
        run_git(&self.publisher, &["commit", "-m", "update remote workflow"]);
        run_git(&self.publisher, &["push", "origin", &self.branch]);
        self.revision = git_stdout(&self.publisher, &["rev-parse", "HEAD"]);
    }
}

fn write_remote_definitions(repo: &Path) {
    std::fs::create_dir_all(repo.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({
            "workflow": "remote-qa",
            "test": "must-be-an-array",
            "ports": {"REMOTE_PORT": 49100, "BAD_PORT": "nope"},
            "flavors": {"review": "strict", "bad": 42},
            "agentProviders": {
                "review@*": {
                    "provider": ["codex", "claude"],
                    "model": "gpt-5"
                },
                "bad": 42
            },
            "vars": {"SOURCE": "remote", "BAD_VAR": false},
            "stage_order": ["review", "in progress"],
            "reserved_port_offsets": [0, "bad", -1, 2],
            "reserved_ports": [48120, 0, 65536, "bad"],
            "workspace": {
                "env": {"REMOTE_ENV": "yes", "BAD_ENV": 42},
                "path": {
                    "prepend": ["remote-bin", 1],
                    "append": "not-an-array"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/workflows/remote-qa.json"),
        json!({
            "description": "remote definition without an explicit name",
            "stages": [{
                "name": "review",
                "agent": "review@strict",
                "agent_provider": ["codex", "claude"],
                "prompt": "REMOTE_WORKFLOW",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/workflows/qa.json"),
        json!({
            "name": "qa",
            "stages": [{
                "name": "remote qa",
                "prompt": "REMOTE_QA_OVERRIDE",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/workflows/zeta.json"),
        json!({
            "name": "zeta",
            "stages": [{
                "name": "zeta",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/workflows/release.v2.json"),
        json!({
            "stages": [{
                "name": "release",
                "prompt": "REMOTE_DOTTED_WORKFLOW",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    // A repo file named after an internal built-in customizes that workflow's
    // definition; re-declaring `"visibility": "internal"` keeps the name out
    // of the manifest (a repo file omitting the field would promote it).
    std::fs::write(
        repo.join(".kanna/workflows/specialty-review.json"),
        json!({
            "name": "specialty-review",
            "visibility": "internal",
            "stages": [{
                "name": "review",
                "prompt": "REMOTE_SPECIALTY_REVIEW",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    // A repo-authored workflow can keep itself out of the picker the same way.
    std::fs::write(
        repo.join(".kanna/workflows/hidden-child.json"),
        json!({
            "name": "hidden-child",
            "visibility": "internal",
            "stages": [{
                "name": "review",
                "prompt": "REMOTE_HIDDEN_CHILD",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    // Reading visibility means parsing every workflow file; a malformed one
    // must stay listed instead of erroring (or silently shrinking) the
    // manifest.
    std::fs::write(repo.join(".kanna/workflows/broken.json"), "{ not json").unwrap();
    std::fs::write(repo.join(".kanna/workflows/invalid\\name.json"), "{}").unwrap();
    std::fs::write(repo.join(".kanna/workflows/schema.json"), "{}").unwrap();
    std::fs::write(
        repo.join(".kanna/agents/review/AGENT.md"),
        r#"---
name: Remote Review
description: Remote strict reviewer
agent_provider:
  - codex
  - claude
permission_mode: dontAsk
allowed_tools:
  - Read
---
REMOTE_AGENT
"#,
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/agents/review/EXTEND.md"),
        "REMOTE_EXTENSION",
    )
    .unwrap();
}

fn local_only_repo() -> (TempDir, PathBuf) {
    let temp = tempfile::Builder::new()
        .prefix("kanna-http-definitions-bundled-")
        .tempdir()
        .unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir_all(repo.join(".kanna/workflows")).unwrap();
    run_git(&repo, &["init", "--initial-branch", "main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Kanna Test"]);
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({"workflow": "local-only", "vars": {"SOURCE": "local-only"}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/workflows/local-only.json"),
        json!({
            "name": "local-only",
            "stages": [{"name": "local", "policy": {"transition": "manual"}}]
        })
        .to_string(),
    )
    .unwrap();
    run_git(&repo, &["add", "."]);
    run_git(&repo, &["commit", "-m", "local definitions"]);
    (temp, repo)
}

/// Publishes `files` to `origin/main` and returns a consumer clone.
/// Definitions resolve from the remote ref, so a fixture that only commits
/// locally is never read — its config comes back empty.
fn published_definitions_repo(label: &str, files: &[(&str, String)]) -> (TempDir, PathBuf) {
    let temp = tempfile::Builder::new()
        .prefix(&format!("kanna-http-definitions-{label}-"))
        .tempdir()
        .unwrap();
    let origin = temp.path().join("origin.git");
    let publisher = temp.path().join("publisher");
    let consumer = temp.path().join("consumer");
    std::fs::create_dir_all(&publisher).unwrap();
    run_git(temp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    run_git(&publisher, &["init", "--initial-branch", "main"]);
    run_git(&publisher, &["config", "user.email", "test@example.com"]);
    run_git(&publisher, &["config", "user.name", "Kanna Test"]);
    for (path, contents) in files {
        let full = publisher.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, contents).unwrap();
    }
    run_git(&publisher, &["add", "."]);
    run_git(&publisher, &["commit", "-m", "publish definitions"]);
    run_git(
        &publisher,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    run_git(&publisher, &["push", "-u", "origin", "main"]);
    run_git(
        temp.path(),
        &[
            "clone",
            "--branch",
            "main",
            origin.to_str().unwrap(),
            consumer.to_str().unwrap(),
        ],
    );
    (temp, consumer)
}

fn manifest_router(seed: &str, repo: &Path) -> axum::Router {
    let repo_path = repo.to_string_lossy().to_string();
    super::test_router_with_seed(seed, "Studio Mac", move |db| {
        db.insert_repo(NewRepo {
            id: "repo-1",
            path: &repo_path,
            name: "Manifest Repo",
            default_branch: Some("main"),
        })
        .unwrap();
    })
}

#[tokio::test]
async fn repo_definition_manifest_reports_retired_workflow_names_as_their_current_name() {
    // The desktop's new-task picker preselects `defaultWorkflow` only when it
    // is a member of `workflows`, and otherwise silently falls back to the
    // first option. Retired names are deliberately absent from `workflows`,
    // so reporting the committed name verbatim would drop an upgraded repo
    // onto the picker's first option — losing the review depth it configured,
    // with no error.
    for (legacy, current) in [
        ("default", "no-review"),
        ("qa", "single-reviewer"),
        ("qa-dispatch", "specialized-reviewers"),
    ] {
        let (_temp, repo) = published_definitions_repo(
            legacy,
            &[(
                ".kanna/config.json",
                json!({ "workflow": legacy }).to_string(),
            )],
        );
        let app = manifest_router(&format!("definitions-legacy-{legacy}"), &repo);

        let (status, manifest) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
        assert_eq!(status, StatusCode::OK);

        // The manifest advertises the name the repo actually resolves to...
        assert_eq!(manifest["defaultWorkflow"], current, "legacy `{legacy}`");

        // ...and that name is selectable, which is the whole point.
        let workflows = manifest["workflows"].as_array().unwrap();
        assert!(
            workflows.iter().any(|name| name == current),
            "`{current}` must be selectable; got {workflows:?}"
        );

        // The retired name stays out of the user-facing choices.
        assert!(
            !workflows.iter().any(|name| name == legacy),
            "`{legacy}` must not be offered; got {workflows:?}"
        );

        // `config` still reports what the repo committed — only the field the
        // UI preselects from is canonicalized.
        assert_eq!(manifest["config"]["workflow"], legacy);

        // The retired name still resolves on the definition route, for
        // callers that ask for it directly.
        let (status, workflow) = json_response(
            &app,
            &format!("/v1/repos/repo-1/kanna-definitions/workflows/{legacy}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(workflow["definition"]["name"], current);
    }
}

#[tokio::test]
async fn repo_definition_manifest_keeps_a_repo_authored_workflow_name_verbatim() {
    // A repo shipping its own `qa.json` makes `qa` a real choice, so it
    // appears in `workflows` and must not be canonicalized away.
    let (_temp, repo) = published_definitions_repo(
        "authored-qa",
        &[
            (
                ".kanna/config.json",
                json!({ "workflow": "qa" }).to_string(),
            ),
            (
                ".kanna/workflows/qa.json",
                json!({
                    "name": "qa",
                    "stages": [{"name": "local", "policy": {"transition": "manual"}}]
                })
                .to_string(),
            ),
        ],
    );
    let app = manifest_router("definitions-authored-qa", &repo);

    let (status, manifest) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["defaultWorkflow"], "qa");
    assert!(manifest["workflows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|name| name == "qa"));
}

#[tokio::test]
async fn list_agents_reports_the_resolved_repo_override_that_task_creation_uses() {
    let (_temp, repo) = published_definitions_repo(
        "agent-list-override",
        &[
            (
                ".kanna/agents/commit/AGENT.md",
                "---\nname: commit\ndescription: Repo commit base\nagent_provider: codex\nmodel: repo-base-model\neffort: high\n---\nRepo commit prompt."
                    .to_string(),
            ),
            (
                ".kanna/agents/commit/EXTEND.md",
                "---\ndescription: Repo commit after extension\nagent_provider: copilot\nmodel: repo-extended-model\neffort: low\n---\nRepo extension."
                    .to_string(),
            ),
            (
                ".kanna/agents/ship/AGENT.md",
                "---\nname: ship\ndescription: Ships the product\nagent_provider: claude\n---\nShip it."
                    .to_string(),
            ),
            (
                ".kanna/agents/review/EXTEND.md",
                "---\ndescription: Repo-extended review\n---\nReview repo rules.".to_string(),
            ),
        ],
    );
    let app = manifest_router("definitions-agent-list-override", &repo);

    let (status, agents) = json_response(&app, "/v1/repos/repo-1/agents").await;
    assert_eq!(status, StatusCode::OK);
    let agents = agents.as_array().expect("agent list response");

    // The repo's commit override omits `visibility`, which deliberately makes
    // the name a public choice — the bundled definition it replaces declares
    // `visibility: internal` and is Kanna's to bind as a stage post.
    let commit = agents
        .iter()
        .find(|agent| agent["name"] == "commit")
        .expect("resolved commit agent");
    assert_eq!(commit["description"], "Repo commit after extension");
    assert_eq!(commit["defaultProvider"], "copilot");
    assert_eq!(commit["defaultModel"], "repo-extended-model");
    assert_eq!(commit["defaultEffort"], "low");
    assert_eq!(commit["source"], "repo_override");

    // `approve` keeps its bundled `visibility: internal`: unlisted here, but
    // its definition still resolves when named explicitly.
    assert!(
        !agents.iter().any(|agent| agent["name"] == "approve"),
        "internal built-in approve must not be listed"
    );
    assert!(
        !agents.iter().any(|agent| agent["name"] == "architect"),
        "internal built-in architect must not be listed"
    );
    let (status, approve) =
        json_response(&app, "/v1/repos/repo-1/kanna-definitions/agents/approve").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(approve["definition"]["name"], "approve");
    assert_eq!(approve["definition"]["visibility"], "internal");
    let (status, architect) =
        json_response(&app, "/v1/repos/repo-1/kanna-definitions/agents/architect").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(architect["definition"]["name"], "architect");
    assert_eq!(architect["definition"]["visibility"], "internal");

    let ship = agents
        .iter()
        .find(|agent| agent["name"] == "ship")
        .expect("repo-authored ship agent");
    assert_eq!(ship["description"], "Ships the product");
    assert_eq!(ship["defaultProvider"], "claude");
    assert!(ship["defaultModel"].is_null());
    assert!(ship["defaultEffort"].is_null());
    assert_eq!(ship["source"], "repo_override");

    let review = agents
        .iter()
        .find(|agent| agent["name"] == "review")
        .expect("repo-extended built-in review agent");
    assert_eq!(review["description"], "Repo-extended review");
    assert_eq!(review["source"], "repo_override");

    let implement = agents
        .iter()
        .find(|agent| agent["name"] == "implement")
        .expect("built-in implement agent");
    assert_eq!(implement["source"], "built_in");

    let task_manager = agents
        .iter()
        .find(|agent| agent["name"] == "task-manager")
        .expect("built-in task-manager agent");
    assert_eq!(task_manager["defaultProvider"], "codex");
    assert_eq!(task_manager["source"], "built_in");
}

fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

async fn response(app: &axum::Router, uri: &str) -> axum::response::Response {
    app.clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn json_response(app: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = response(app, uri).await;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = from_slice(&body).unwrap_or_else(|error| {
        panic!(
            "expected JSON response for {uri} ({status}), got {:?}: {error}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, value)
}

async fn json_post(app: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(Request::post(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = from_slice(&body).unwrap_or_else(|error| {
        panic!(
            "expected JSON response for POST {uri} ({status}), got {:?}: {error}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, value)
}

fn workflow_names(manifest: &Value) -> Vec<String> {
    manifest["workflows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect()
}

/// Reading definitions must never wait on the network, but choosing one must
/// see what the remote actually holds. `fetch-origin` is where that trade is
/// made: it is the only definitions route that fetches, so a client refreshes
/// the choices it is about to offer without any render blocking on Git.
#[tokio::test]
async fn the_manifest_route_reads_local_refs_and_fetch_origin_refreshes_them() {
    let workflow = |name: &str| {
        json!({
            "name": name,
            "stages": [{ "name": "in progress", "prompt": "WORK" }],
        })
        .to_string()
    };
    let (temp, repo) = published_definitions_repo(
        "fetch-origin",
        &[
            (
                ".kanna/config.json",
                json!({ "workflow": "first" }).to_string(),
            ),
            (".kanna/workflows/first.json", workflow("first")),
        ],
    );

    let (status, manifest) = json_response(
        &manifest_router("definitions-fetch-origin-before", &repo),
        "/v1/repos/repo-1/kanna-definitions",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let published_revision = manifest["revision"].as_str().unwrap().to_string();
    assert_eq!(
        workflow_names(&manifest).contains(&"second".to_string()),
        false
    );

    // Publish a second workflow. Nothing has fetched, so the consumer's
    // remote-tracking ref still points at the first commit.
    let publisher = temp.path().join("publisher");
    std::fs::write(
        publisher.join(".kanna/workflows/second.json"),
        workflow("second"),
    )
    .unwrap();
    run_git(&publisher, &["add", "."]);
    run_git(&publisher, &["commit", "-m", "publish second workflow"]);
    run_git(&publisher, &["push", "origin", "main"]);

    // A cold cache proves the read path itself does not fetch: this router has
    // never resolved this repo, and still reports the pre-push revision.
    let app = manifest_router("definitions-fetch-origin-after", &repo);
    let (status, stale) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stale["revision"], published_revision);
    assert!(!workflow_names(&stale).contains(&"second".to_string()));

    let (status, refreshed) = json_post(&app, "/v1/repos/repo-1/fetch-origin").await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(refreshed["revision"], published_revision);
    assert!(workflow_names(&refreshed).contains(&"second".to_string()));

    // The refresh replaces the cached entry, so ordinary reads see it too
    // rather than waiting out the TTL.
    let (status, after) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["revision"], refreshed["revision"]);
    assert!(workflow_names(&after).contains(&"second".to_string()));
}

#[tokio::test]
async fn repo_definition_routes_return_one_remote_revision_and_normalized_snake_case_definitions() {
    let fixture = RemoteDefinitionsFixture::new("routes", "dev");
    let app = fixture.router("repo-1");

    let (status, manifest) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["revision"], fixture.revision);
    assert_eq!(manifest["refName"], "origin/dev");
    assert_eq!(manifest["config"]["vars"]["SOURCE"], "remote");
    assert_eq!(manifest["config"]["ports"], json!({"REMOTE_PORT": 49100}));
    assert_eq!(manifest["config"]["flavors"], json!({"review": "strict"}));
    assert_eq!(
        manifest["config"]["agentProviders"],
        json!({
            "review@*": {
                "provider": ["codex", "claude"],
                "model": "gpt-5"
            }
        })
    );
    assert_eq!(manifest["config"]["reserved_port_offsets"], json!([0, 2]));
    assert_eq!(manifest["config"]["reserved_ports"], json!([48120]));
    assert_eq!(
        manifest["config"]["workspace"],
        json!({
            "env": {"REMOTE_ENV": "yes"},
            "path": {"prepend": ["remote-bin"]}
        })
    );
    assert!(manifest["config"].get("test").is_none());
    assert!(manifest["config"]["vars"].get("BAD_VAR").is_none());
    assert_eq!(
        manifest["config"]["stage_order"],
        json!(["review", "in progress"])
    );
    assert!(manifest["config"].get("stageOrder").is_none());
    assert_eq!(manifest["defaultWorkflow"], "remote-qa");
    // `specialty-review` and `hidden-child` are absent because their files
    // declare `"visibility": "internal"` (asserted resolvable below), while
    // the malformed `broken` stays listed: an unparseable file cannot have
    // declared itself internal, and dropping it would hide the repo's own
    // workflow behind a silent manifest shrink.
    assert_eq!(
        manifest["workflows"],
        json!([
            "broken",
            "no-review",
            "qa",
            "release.v2",
            "remote-qa",
            "single-reviewer",
            "specialized-reviewers",
            "zeta"
        ])
    );
    assert_eq!(
        manifest
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "config",
            "defaultPipeline",
            "defaultWorkflow",
            "pipelines",
            "workflows",
            "refName",
            "revision"
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );

    let (status, workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/remote-qa",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workflow["revision"], fixture.revision);
    assert_eq!(workflow["definition"]["name"], "remote-qa");
    assert_eq!(
        workflow["definition"]["stages"][0]["prompt"],
        "REMOTE_WORKFLOW"
    );
    assert_eq!(
        workflow["definition"]["stages"][0]["agent_provider"],
        json!(["codex", "claude"])
    );
    assert!(workflow["definition"]["stages"][0]
        .get("agentProvider")
        .is_none());

    let (legacy_status, legacy_workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/pipelines/remote-qa",
    )
    .await;
    assert_eq!(legacy_status, StatusCode::OK);
    assert_eq!(legacy_workflow, workflow);

    let (status, dotted_workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/release.v2",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dotted_workflow["definition"]["name"], "release.v2");
    assert_eq!(
        dotted_workflow["definition"]["stages"][0]["prompt"],
        "REMOTE_DOTTED_WORKFLOW"
    );

    // Unlisted, but still resolvable — and the repo's override still wins over
    // the bundled definition, exactly as it does for a listed workflow.
    let (status, internal_workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/specialty-review",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        internal_workflow["definition"]["stages"][0]["prompt"],
        "REMOTE_SPECIALTY_REVIEW"
    );
    assert_eq!(internal_workflow["definition"]["visibility"], "internal");

    let (status, hidden_child) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/hidden-child",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        hidden_child["definition"]["stages"][0]["prompt"],
        "REMOTE_HIDDEN_CHILD"
    );

    // The malformed workflow's parse error belongs to its own endpoint, not
    // to the manifest that listed it.
    let broken = response(&app, "/v1/repos/repo-1/kanna-definitions/workflows/broken").await;
    assert_eq!(broken.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let (status, agent) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/agents/review%40strict",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(agent["revision"], fixture.revision);
    assert_eq!(agent["definition"]["name"], "Remote Review");
    assert_eq!(
        agent["definition"]["agent_provider"],
        json!(["codex", "claude"])
    );
    assert!(agent["definition"].get("agentProvider").is_none());
    assert!(agent["definition"]["prompt"]
        .as_str()
        .unwrap()
        .contains("REMOTE_EXTENSION"));
    assert!(!agent["definition"]["prompt"]
        .as_str()
        .unwrap()
        .contains("LOCAL_STALE_EXTENSION"));
}

#[tokio::test]
async fn repo_definition_routes_share_a_fresh_resolved_snapshot() {
    let mut fixture = RemoteDefinitionsFixture::new("route-cache", "main");
    let app = fixture.router("repo-1");

    let (status, manifest) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    let cached_revision = manifest["revision"].clone();

    fixture.publish_workflow_prompt("REMOTE_WORKFLOW_AFTER_CACHE");

    let (status, workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/remote-qa",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workflow["revision"], cached_revision);
    assert_eq!(
        workflow["definition"]["stages"][0]["prompt"],
        "REMOTE_WORKFLOW"
    );
}

#[tokio::test]
async fn repo_definition_routes_use_bundled_only_values_without_a_remote_ref() {
    let (_temp, repo) = local_only_repo();
    let repo_path = repo.to_string_lossy().to_string();
    let app = super::test_router_with_seed("definitions-bundled", "Studio Mac", move |db| {
        db.insert_repo(NewRepo {
            id: "repo-1",
            path: &repo_path,
            name: "Bundled Repo",
            default_branch: Some("main"),
        })
        .unwrap();
    });

    let (status, manifest) = json_response(&app, "/v1/repos/repo-1/kanna-definitions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["revision"], Value::Null);
    assert_eq!(manifest["refName"], "origin/main");
    assert_eq!(manifest["config"], json!({}));
    assert_eq!(manifest["defaultWorkflow"], "no-review");
    // Purpose-built child workflows stay out of the public lineup: the QA
    // dispatcher binds `specialty-review`, while the task manager binds
    // `architect-consultation` for a bounded advisory child.
    assert_eq!(
        manifest["workflows"],
        json!(["no-review", "single-reviewer", "specialized-reviewers"])
    );

    let (status, workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/no-review",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workflow["revision"], Value::Null);
    assert_eq!(workflow["definition"]["name"], "no-review");

    // Unlisted is not unresolvable: the dispatcher still names it on create,
    // so the definition must serve exactly as before.
    let (status, workflow) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/specialty-review",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workflow["definition"]["name"], "specialty-review");

    let (status, consultation) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/workflows/architect-consultation",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(consultation["definition"]["name"], "architect-consultation");
    assert_eq!(
        consultation["definition"]["stages"][0]["agent"],
        "architect"
    );
    assert_eq!(consultation["definition"]["visibility"], "internal");
}

#[tokio::test]
async fn repo_definition_routes_reject_unsafe_names_and_report_missing_resources() {
    let fixture = RemoteDefinitionsFixture::new("lookup-errors", "dev");
    let app = fixture.router("repo-1");

    for uri in [
        "/v1/repos/repo-1/kanna-definitions/workflows/%2E%2E",
        "/v1/repos/repo-1/kanna-definitions/workflows/bad%5Cname",
        "/v1/repos/repo-1/kanna-definitions/agents/review%40%2E%2E",
        "/v1/repos/repo-1/kanna-definitions/agents/review%40strict%40extra",
    ] {
        assert_eq!(
            response(&app, uri).await.status(),
            StatusCode::BAD_REQUEST,
            "{uri}"
        );
    }

    assert_eq!(
        response(&app, "/v1/repos/repo-1/kanna-definitions/workflows/missing")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        response(&app, "/v1/repos/repo-1/kanna-definitions/agents/missing")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        response(&app, "/v1/repos/unknown/kanna-definitions")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn malformed_remote_definition_returns_internal_server_error() {
    let mut fixture = RemoteDefinitionsFixture::new("malformed", "dev");
    let app = fixture.router("repo-1");
    fixture.publish_malformed_workflow("broken");

    let response = response(&app, "/v1/repos/repo-1/kanna-definitions/workflows/broken").await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}
