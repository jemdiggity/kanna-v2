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
            json!({"pipeline": "local-stale", "vars": {"SOURCE": "local-stale"}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            consumer.join(".kanna/pipelines/remote-qa.json"),
            json!({
                "name": "local-stale",
                "stages": [{
                    "name": "local",
                    "prompt": "LOCAL_STALE_PIPELINE",
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

    fn publish_malformed_pipeline(&mut self, name: &str) {
        std::fs::write(
            self.publisher.join(format!(".kanna/pipelines/{name}.json")),
            "{not valid json",
        )
        .unwrap();
        run_git(&self.publisher, &["add", ".kanna"]);
        run_git(
            &self.publisher,
            &["commit", "-m", "publish malformed pipeline"],
        );
        run_git(&self.publisher, &["push", "origin", &self.branch]);
        self.revision = git_stdout(&self.publisher, &["rev-parse", "HEAD"]);
    }

    fn publish_pipeline_prompt(&mut self, prompt: &str) {
        std::fs::write(
            self.publisher.join(".kanna/pipelines/remote-qa.json"),
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
        run_git(&self.publisher, &["commit", "-m", "update remote pipeline"]);
        run_git(&self.publisher, &["push", "origin", &self.branch]);
        self.revision = git_stdout(&self.publisher, &["rev-parse", "HEAD"]);
    }
}

fn write_remote_definitions(repo: &Path) {
    std::fs::create_dir_all(repo.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({
            "pipeline": "remote-qa",
            "test": "must-be-an-array",
            "ports": {"REMOTE_PORT": 49100, "BAD_PORT": "nope"},
            "flavors": {"review": "strict", "bad": 42},
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
        repo.join(".kanna/pipelines/remote-qa.json"),
        json!({
            "description": "remote definition without an explicit name",
            "stages": [{
                "name": "review",
                "agent": "review@strict",
                "agent_provider": ["codex", "claude"],
                "prompt": "REMOTE_PIPELINE",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/pipelines/qa.json"),
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
        repo.join(".kanna/pipelines/zeta.json"),
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
        repo.join(".kanna/pipelines/release.v2.json"),
        json!({
            "stages": [{
                "name": "release",
                "prompt": "REMOTE_DOTTED_PIPELINE",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(repo.join(".kanna/pipelines/invalid\\name.json"), "{}").unwrap();
    std::fs::write(repo.join(".kanna/pipelines/schema.json"), "{}").unwrap();
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
    std::fs::create_dir_all(repo.join(".kanna/pipelines")).unwrap();
    run_git(&repo, &["init", "--initial-branch", "main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Kanna Test"]);
    std::fs::write(
        repo.join(".kanna/config.json"),
        json!({"pipeline": "local-only", "vars": {"SOURCE": "local-only"}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        repo.join(".kanna/pipelines/local-only.json"),
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
    assert_eq!(manifest["defaultPipeline"], "remote-qa");
    assert_eq!(
        manifest["pipelines"],
        json!([
            "default",
            "qa",
            "qa-dispatch",
            "release.v2",
            "remote-qa",
            "specialty-review",
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
            "pipelines",
            "refName",
            "revision"
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );

    let (status, pipeline) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/pipelines/remote-qa",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pipeline["revision"], fixture.revision);
    assert_eq!(pipeline["definition"]["name"], "remote-qa");
    assert_eq!(
        pipeline["definition"]["stages"][0]["prompt"],
        "REMOTE_PIPELINE"
    );
    assert_eq!(
        pipeline["definition"]["stages"][0]["agent_provider"],
        json!(["codex", "claude"])
    );
    assert!(pipeline["definition"]["stages"][0]
        .get("agentProvider")
        .is_none());

    let (status, dotted_pipeline) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/pipelines/release.v2",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dotted_pipeline["definition"]["name"], "release.v2");
    assert_eq!(
        dotted_pipeline["definition"]["stages"][0]["prompt"],
        "REMOTE_DOTTED_PIPELINE"
    );

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

    fixture.publish_pipeline_prompt("REMOTE_PIPELINE_AFTER_CACHE");

    let (status, pipeline) = json_response(
        &app,
        "/v1/repos/repo-1/kanna-definitions/pipelines/remote-qa",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pipeline["revision"], cached_revision);
    assert_eq!(
        pipeline["definition"]["stages"][0]["prompt"],
        "REMOTE_PIPELINE"
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
    assert_eq!(manifest["defaultPipeline"], "default");
    assert_eq!(
        manifest["pipelines"],
        json!(["default", "qa", "qa-dispatch", "specialty-review"])
    );

    let (status, pipeline) =
        json_response(&app, "/v1/repos/repo-1/kanna-definitions/pipelines/default").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pipeline["revision"], Value::Null);
    assert_eq!(pipeline["definition"]["name"], "default");
}

#[tokio::test]
async fn repo_definition_routes_reject_unsafe_names_and_report_missing_resources() {
    let fixture = RemoteDefinitionsFixture::new("lookup-errors", "dev");
    let app = fixture.router("repo-1");

    for uri in [
        "/v1/repos/repo-1/kanna-definitions/pipelines/%2E%2E",
        "/v1/repos/repo-1/kanna-definitions/pipelines/bad%5Cname",
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
        response(&app, "/v1/repos/repo-1/kanna-definitions/pipelines/missing")
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
    fixture.publish_malformed_pipeline("broken");

    let response = response(&app, "/v1/repos/repo-1/kanna-definitions/pipelines/broken").await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}
