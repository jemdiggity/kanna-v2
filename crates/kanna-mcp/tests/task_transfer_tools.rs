//! The transfer tools, over MCP, against a real `kanna-server`.
//!
//! On 2026-09-06 a task manager was asked to move a task between two of the
//! operator's machines and found no transfer tool in the MCP catalog and no
//! `kanna-cli task push`. It read desktop source for a peer id, posted it at
//! the raw HTTP route, took `scheduled: true` for a completed move — and the
//! transfer was in fact failing on a relay socket.
//!
//! `crates/kanna-tool-catalog` pins what the tools *declare*. This pins what
//! they *do*: the JSON-RPC call, `kanna-mcp`'s own request resolution, the HTTP
//! route on a real server, and the real SQLite rows behind it. The catalog is
//! shared with `kanna-cli`, but the execution path is not — `kanna-mcp` has its
//! own — so the wiring has to be exercised here as well as in the desktop E2E
//! that performs an actual two-machine move.
//!
//! See `common/mod.rs` for the harness.

mod common;

use common::{execute_sql, seed_task, start_bare_chain};
use serde_json::{json, Value};

async fn seed_transfer(
    server: &common::RunningServer,
    id: &str,
    direction: &str,
    status: &str,
    source_task_id: &str,
    local_task_id: &str,
    error: Option<&str>,
) {
    execute_sql(
        server,
        "INSERT INTO task_transfer (
            id, direction, status, source_peer_id, target_peer_id,
            source_desktop_id, target_desktop_id, source_task_id, local_task_id,
            started_at, completed_at, error
         ) VALUES (?, ?, ?, 'peer-source', 'peer-target',
                   'desktop-source', 'desktop-target', ?, ?,
                   datetime('now'), NULL, ?)",
        json!([id, direction, status, source_task_id, local_task_id, error]),
    )
    .await;
}

/// The observation half, which is the one an agent must read before saying a
/// task moved. The verdict has to come back over MCP from real rows.
#[tokio::test]
async fn task_transfers_answer_from_the_server_s_own_rows() {
    let task_id = "task-transfer-observed";
    let (server, _daemon, mut mcp) = start_bare_chain("transfer-observed").await;
    seed_task(&server, task_id, "idle").await;

    // Nothing recorded yet. An empty list is "nothing has arrived", never
    // "nothing was requested" — the tool description says so, and the shape has
    // to make the distinction possible.
    mcp.call_tool(2, "kanna_task_transfers", json!({ "task_id": task_id }));
    let empty = mcp.recv_task();
    assert_eq!(empty["taskId"], task_id);
    assert_eq!(empty["transfers"], json!([]));

    seed_transfer(
        &server,
        "transfer-live",
        "outgoing",
        "streaming",
        task_id,
        task_id,
        None,
    )
    .await;
    mcp.call_tool(3, "kanna_task_transfers", json!({ "task_id": task_id }));
    let pending = mcp.recv_task();
    assert_eq!(pending["transfers"][0]["id"], "transfer-live");
    // Both vocabularies: the engine's own status, and the coarse verdict every
    // agent surface reads.
    assert_eq!(pending["transfers"][0]["status"], "streaming");
    assert_eq!(pending["transfers"][0]["state"], "pending");
    assert_eq!(pending["transfers"][0]["direction"], "outgoing");
    assert_eq!(pending["transfers"][0]["sourceMachineId"], "desktop-source");
    assert_eq!(pending["transfers"][0]["targetMachineId"], "desktop-target");

    // A move that ended badly must read as failed, with the reason. "Not
    // completed yet" and "will never complete" are the two answers this
    // surface exists to keep apart.
    seed_transfer(
        &server,
        "transfer-doomed",
        "outgoing",
        "failed",
        task_id,
        task_id,
        Some("cloud transfer relay rejected tunnel"),
    )
    .await;
    mcp.call_tool(4, "kanna_task_transfers", json!({ "task_id": task_id }));
    let listed = mcp.recv_task();
    let failed = listed["transfers"]
        .as_array()
        .expect("transfers")
        .iter()
        .find(|transfer| transfer["id"] == "transfer-doomed")
        .expect("the failed transfer");
    assert_eq!(failed["state"], "failed");
    assert_eq!(failed["error"], "cloud transfer relay rejected tunnel");

    // The destination's own id for the same task, which is how the two halves
    // of one move are tied together.
    seed_transfer(
        &server,
        "transfer-arrived",
        "incoming",
        "completed",
        "task-elsewhere",
        task_id,
        None,
    )
    .await;
    mcp.call_tool(5, "kanna_task_transfers", json!({ "task_id": task_id }));
    let both = mcp.recv_task();
    let incoming = both["transfers"]
        .as_array()
        .expect("transfers")
        .iter()
        .find(|transfer| transfer["direction"] == "incoming")
        .expect("the incoming transfer");
    assert_eq!(incoming["state"], "completed");
    assert_eq!(incoming["sourceTaskId"], "task-elsewhere");
    assert_eq!(incoming["localTaskId"], task_id);
}

/// A destination this machine cannot resolve must reach the agent as a refusal.
///
/// This server has no transfer peer registry at all, which is the strongest
/// form of "the destination could not be resolved". The failure that matters is
/// not the message but the absence of a consequence: the call must not answer
/// like a scheduled push, and it must not leave work behind for the engine to
/// fail later, out of the agent's sight.
#[tokio::test]
async fn a_push_at_an_unresolvable_destination_refuses_instead_of_scheduling() {
    let task_id = "task-transfer-unroutable";
    let (server, _daemon, mut mcp) = start_bare_chain("transfer-unroutable").await;
    seed_task(&server, task_id, "idle").await;

    mcp.call_tool(
        2,
        "kanna_push_task",
        json!({ "task_id": task_id, "to_machine": "desktop-nowhere" }),
    );
    let refusal = mcp.recv();
    let text = refusal["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        refusal["result"]["isError"] == json!(true) || refusal.get("error").is_some(),
        "an unresolvable destination must not answer like a scheduled push: {refusal}"
    );
    assert!(
        !text.contains("\"scheduled\":true") && !text.contains("\"scheduled\": true"),
        "{text}"
    );

    // Nothing was queued and nothing was recorded, so the next reader of this
    // task sees no move rather than a phantom one.
    mcp.call_tool(3, "kanna_task_transfers", json!({ "task_id": task_id }));
    assert_eq!(mcp.recv_task()["transfers"], json!([]));

    let queued: Value = reqwest::Client::new()
        .post(format!("{}/v1/e2e/sql", server.base_url))
        .json(&json!({
            "sql": "SELECT COUNT(*) AS queued FROM transfer_work WHERE payload_json LIKE ?",
            "params": [format!("%{task_id}%")],
            "query": true,
        }))
        .send()
        .await
        .expect("query transfer work")
        .json()
        .await
        .expect("transfer work rows");
    assert_eq!(queued["rows"][0]["queued"], 0, "{queued}");
}

/// A pull is expressed only by a process on the machine the task is moving to,
/// and this MCP client is one — so the call reaches the sidecar control plane
/// rather than being turned away at the boundary. With no sidecar behind it the
/// request cannot be delivered, and that has to surface as a failure rather
/// than as an accepted request nobody will ever act on.
#[tokio::test]
async fn a_pull_reaches_the_transfer_control_plane_and_reports_when_it_cannot_be_delivered() {
    let (server, _daemon, mut mcp) = start_bare_chain("transfer-pull-reach").await;
    seed_task(&server, "task-transfer-pull", "idle").await;

    mcp.call_tool(
        2,
        "kanna_pull_task",
        json!({ "source_task_id": "task-elsewhere", "from_machine": "peer-primary" }),
    );
    let response = mcp.recv();
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        response["result"]["isError"] == json!(true) || response.get("error").is_some(),
        "an undeliverable pull must not answer like an accepted request: {response}"
    );
    // Specifically not the authorization refusal: a loopback MCP client is
    // exactly the caller this route is for, so reaching the peer registry at
    // all is what this asserts.
    assert!(
        !text.contains("direct desktop loopback connection"),
        "the pull was refused at the boundary rather than attempted: {text}"
    );
    let _ = server;
}
