# Mobile Task Card Waiting Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only stage, the current editable title, and the latest bounded waiting-state agent prompt on mobile task cards, with transition-driven LAN/cloud synchronization.

**Architecture:** Extend daemon status transitions with an optional provider-aware waiting prompt, persist changed values in kanna-server's existing compatibility column, and expose an explicit `waitingPromptSnippet` through LAN and cloud task models. Publish changed cloud prompts through a per-task trailing queue, then simplify the mobile card and apply exact 80/240 Unicode-scalar display limits.

**Tech Stack:** Rust, Tokio, daemon protocol, SQLite/rusqlite, Vue 3, Firebase Firestore, React Native, TypeScript, Vitest, Cargo tests.

**Kanna stage constraint:** Do not create commits in this worktree. The pipeline's later post/stages own committing.

---

## File Map

- `crates/daemon/src/protocol.rs` — optional waiting prompt on daemon status events.
- `crates/daemon/src/headless_terminal.rs` — provider-aware extraction and 240-scalar bounding from visible PTY state.
- `crates/daemon/src/session.rs` — expose the current PTY waiting prompt through `SessionHandle`.
- `crates/daemon/src/output.rs` — attach the extracted prompt only to changed `waiting`/`idle` events.
- `crates/daemon/src/agent.rs` — recover the latest assistant text from agent journals.
- `crates/daemon/src/agent_runtime.rs` — broadcast optional agent-mode waiting prompts.
- `crates/daemon/src/agent_runtime/{commands,readers,lifecycle,adoption}.rs` — maintain and emit latest assistant text across spawn, turns, exit, and handoff.
- `crates/kanna-server/src/db/pipeline_items.rs` — change-aware persistence into `last_output_preview`.
- `crates/kanna-server/src/terminal_watcher.rs` — consume waiting prompts from daemon status events.
- `crates/kanna-server/src/mobile_api.rs` — add backward-compatible `waitingPromptSnippet` to LAN/API summaries.
- `crates/kanna-server/src/ksp.rs` — accept the extended daemon event while keeping the KSP status frame stable.
- `apps/desktop/src/utils/cloudTaskSnapshot.ts` — publish the waiting prompt separately from the original prompt.
- `apps/desktop/src/services/desktopCloudTaskIndex.ts` — map remote waiting prompts to the compatibility field.
- `apps/desktop/src/services/waitingPromptPublishQueue.ts` — per-task trailing cloud publication queue.
- `apps/desktop/src/services/waitingPromptPublishQueue.test.ts` — fake-timer coverage for coalescing and deduplication.
- `apps/desktop/src/composables/useAppCloudWorkspace.ts` — schedule changed prompt documents and seed/cancel the queue.
- `apps/mobile/src/lib/api/types.ts` — explicit mobile `waitingPromptSnippet` model.
- `apps/mobile/src/lib/firebase/taskIndex.ts` — keep task prompt and waiting prompt distinct.
- `apps/mobile/src/screens/taskPresentation.ts` — exact card title/snippet truncation and placeholder model.
- `apps/mobile/src/components/{TaskCard,TaskList}.tsx` — remove scope/repository metadata and render the compact card.
- `apps/mobile/src/screens/TasksScreen.tsx` — stop passing redundant per-card repository/recent metadata.
- Existing adjacent Rust and TypeScript test files — contract coverage at every boundary.

---

### Task 1: Add Waiting Prompt Data to Daemon PTY Status Transitions

**Files:**
- Modify: `crates/daemon/src/protocol.rs:245-258,450-525`
- Modify: `crates/daemon/src/headless_terminal.rs:13-25,159-230,350-525,660-1080`
- Modify: `crates/daemon/src/session.rs:188-240`
- Modify: `crates/daemon/src/output.rs:450-470`
- Modify: `crates/daemon/src/client.rs:38-55`
- Modify: `crates/kanna-server/src/ksp.rs:680-705`

- [ ] **Step 1: Write failing protocol and PTY extraction tests**

Add a protocol round-trip test in `crates/daemon/src/protocol.rs`:

```rust
#[test]
fn status_changed_roundtrips_optional_waiting_prompt() {
    let event = Event::StatusChanged {
        session_id: "task-1".to_string(),
        status: SessionStatus::Idle,
        waiting_prompt_snippet: Some("The branch is ready for review.".to_string()),
    };

    let json = serde_json::to_string(&event).unwrap();
    let decoded: Event = serde_json::from_str(&json).unwrap();

    assert!(matches!(
        decoded,
        Event::StatusChanged {
            session_id,
            status: SessionStatus::Idle,
            waiting_prompt_snippet: Some(prompt),
        } if session_id == "task-1" && prompt == "The branch is ready for review."
    ));
}

#[test]
fn status_changed_accepts_legacy_payload_without_waiting_prompt() {
    let decoded: Event = serde_json::from_str(
        r#"{"type":"StatusChanged","session_id":"task-1","status":"idle"}"#,
    )
    .unwrap();

    assert!(matches!(
        decoded,
        Event::StatusChanged {
            waiting_prompt_snippet: None,
            ..
        }
    ));
}
```

Add extraction tests in `crates/daemon/src/headless_terminal.rs`:

```rust
#[test]
fn idle_prompt_snippet_keeps_agent_text_and_drops_codex_chrome() {
    let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
    terminal.write(
        concat!(
            "OpenAI Codex\r\n",
            "• Updated the mobile task card and all focused tests pass.\r\n",
            "gpt-5.5 high · /tmp/.kanna-worktrees/task-1\r\n",
            "────────────────────────────────\r\n",
            "› \r\n",
        )
        .as_bytes(),
    );

    assert_eq!(
        terminal
            .waiting_prompt_snippet(Some(AgentProvider::Codex))
            .unwrap()
            .as_deref(),
        Some("• Updated the mobile task card and all focused tests pass.")
    );
}

#[test]
fn waiting_prompt_snippet_uses_visible_permission_question() {
    let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
    terminal.write(
        concat!(
            "Claude Code\r\n",
            "Do you want to allow Bash to run the focused tests?\r\n",
            "1. Yes\r\n",
            "2. No\r\n",
        )
        .as_bytes(),
    );

    assert_eq!(
        terminal
            .waiting_prompt_snippet(Some(AgentProvider::Claude))
            .unwrap()
            .as_deref(),
        Some("Do you want to allow Bash to run the focused tests?")
    );
}

#[test]
fn waiting_prompt_snippet_is_bounded_to_240_unicode_scalars() {
    let bounded = bound_waiting_prompt(&"界".repeat(300)).unwrap();

    assert_eq!(bounded.chars().count(), 240);
    assert!(bounded.ends_with('…'));
}
```

- [ ] **Step 2: Run the daemon tests and verify RED**

Run:

```bash
cargo test -p kanna-daemon status_changed_roundtrips_optional_waiting_prompt
cargo test -p kanna-daemon waiting_prompt_snippet
```

Expected: compilation fails because `Event::StatusChanged.waiting_prompt_snippet`, `HeadlessTerminal::waiting_prompt_snippet`, and `bound_waiting_prompt` do not exist.

- [ ] **Step 3: Extend the protocol and implement bounded PTY extraction**

Change the daemon event variant in `crates/daemon/src/protocol.rs` to:

```rust
StatusChanged {
    session_id: String,
    status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    waiting_prompt_snippet: Option<String>,
},
```

Add these helpers beside the existing footer/status helpers in `crates/daemon/src/headless_terminal.rs`:

```rust
const WAITING_PROMPT_MAX_CHARS: usize = 240;
const WAITING_PROMPT_MAX_LINES: usize = 3;

pub fn bound_waiting_prompt(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }

    let chars = normalized.chars().collect::<Vec<_>>();
    if chars.len() <= WAITING_PROMPT_MAX_CHARS {
        return Some(normalized);
    }

    let mut bounded = chars[..WAITING_PROMPT_MAX_CHARS - 1]
        .iter()
        .collect::<String>();
    bounded.push('…');
    Some(bounded)
}

fn line_is_visual_divider(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|character| matches!(character, '─' | '━' | '—' | '-' | ' '))
}

fn line_is_provider_chrome(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty()
        || line_is_visual_divider(trimmed)
        || line_starts_with_prompt(trimmed, &[CLAUDE_IDLE_PROMPT, CODEX_IDLE_PROMPT])
        || line_contains_worktree_path(trimmed)
        || contains_ascii_case_insensitive(trimmed, INTERRUPT_MARKER)
        || contains_ascii_case_insensitive(trimmed, COPILOT_BUSY_MARKER)
        || contains_ascii_case_insensitive(trimmed, ANTIGRAVITY_BUSY_MARKER)
        || contains_ascii_case_insensitive(trimmed, "bypass permissions")
        || contains_ascii_case_insensitive(trimmed, "/ commands")
        || matches!(trimmed, "Claude Code" | "OpenAI Codex")
}

fn waiting_prompt_from_lines(lines: &[String]) -> Option<String> {
    if let Some(question) = lines
        .iter()
        .rev()
        .find(|line| contains_ascii_case_insensitive(line, WAITING_MARKER))
    {
        return bound_waiting_prompt(question);
    }

    let mut content = Vec::new();
    for line in lines.iter().rev() {
        if line_is_provider_chrome(line) {
            if content.is_empty() {
                continue;
            }
            break;
        }
        content.push(line.trim());
        if content.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    content.reverse();
    bound_waiting_prompt(&content.join(" "))
}
```

Add the method inside `impl HeadlessTerminal`:

```rust
pub fn waiting_prompt_snippet(
    &mut self,
    provider: Option<AgentProvider>,
) -> HeadlessTerminalResult<Option<String>> {
    if provider.is_none() {
        return Ok(None);
    }
    let footer_lines = self.visible_footer_lines(STATUS_ROWS)?;
    Ok(waiting_prompt_from_lines(&footer_lines))
}
```

Expose it through `SessionHandle` in `crates/daemon/src/session.rs`:

```rust
pub async fn waiting_prompt_snippet(
    &self,
) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut state = self.state.lock().await;
    let provider = state.agent_provider;
    state.headless_terminal.waiting_prompt_snippet(provider)
}
```

- [ ] **Step 4: Emit the prompt only on changed waiting/idle status events**

Replace `emit_status_changed` in `crates/daemon/src/output.rs` with:

```rust
async fn emit_status_changed(
    session: &Arc<SessionHandle>,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
) {
    if !session.update_status(status).await {
        return;
    }

    let waiting_prompt_snippet = if matches!(status, SessionStatus::Waiting | SessionStatus::Idle) {
        match session.waiting_prompt_snippet().await {
            Ok(prompt) => prompt,
            Err(error) => {
                log::warn!(
                    "failed to extract waiting prompt for session {}: {}",
                    session_id,
                    error
                );
                None
            }
        }
    } else {
        None
    };

    if let Ok(json) = serde_json::to_string(&Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet,
    }) {
        let _ = broadcast_tx.send(json);
    }
}
```

Add `waiting_prompt_snippet: None` to the replay/spawn/kill constructors in `crates/daemon/src/client.rs` and agent runtime files. Change actual daemon-event destructuring in `crates/kanna-server/src/ksp.rs` to include `..`, keeping `ServerFrame::StatusChanged` unchanged:

```rust
Ok(DaemonEvent::StatusChanged {
    session_id: event_session,
    status,
    ..
}) if event_session == session_id => {
```

- [ ] **Step 5: Run focused daemon and KSP tests and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon status_changed
cargo test -p kanna-daemon waiting_prompt
cargo test -p kanna-server ksp
```

Expected: all selected tests pass with no protocol-pattern compilation errors.

---

### Task 2: Attach the Latest Assistant Text to Headless Agent Status

**Files:**
- Modify: `crates/daemon/src/agent.rs:140-270,295-330,580-670`
- Modify: `crates/daemon/src/agent_runtime.rs:75-110`
- Modify: `crates/daemon/src/agent_runtime/commands.rs:80-135`
- Modify: `crates/daemon/src/agent_runtime/readers.rs:80-180,200-245`
- Modify: `crates/daemon/src/agent_runtime/adoption.rs:40-100`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs:45-70`

- [ ] **Step 1: Write failing journal and status tests**

Add to `crates/daemon/src/agent.rs` tests:

```rust
#[test]
fn journal_returns_latest_bounded_assistant_text() {
    let (_dir, mut journal) = journal_in_temp();
    journal.append(AgentEvent::AssistantText {
        text: "Older response".into(),
        truncated: false,
    });
    journal.append(AgentEvent::ToolResult {
        call_id: "tool-1".into(),
        output: "ignored tool output".into(),
        truncated: false,
        is_error: false,
    });
    journal.append(AgentEvent::AssistantText {
        text: "Latest answer\nwith spacing".into(),
        truncated: false,
    });

    assert_eq!(
        journal.latest_assistant_prompt().as_deref(),
        Some("Latest answer with spacing")
    );
}
```

Add a unit test beside `set_status` in `crates/daemon/src/agent_runtime.rs` that constructs a status event through a small extracted helper:

```rust
#[test]
fn idle_agent_status_carries_latest_assistant_prompt() {
    let event = status_changed_event(
        "agent-1",
        SessionStatus::Idle,
        Some("Ready for review".to_string()),
    );

    assert!(matches!(
        event,
        Event::StatusChanged {
            waiting_prompt_snippet: Some(prompt),
            ..
        } if prompt == "Ready for review"
    ));
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test -p kanna-daemon latest_bounded_assistant_text
cargo test -p kanna-daemon idle_agent_status_carries
```

Expected: compilation fails because the journal accessor, record field, and status-event helper do not exist.

- [ ] **Step 3: Track and restore latest assistant text**

Add to `AgentJournal` in `crates/daemon/src/agent.rs`:

```rust
pub fn latest_assistant_prompt(&self) -> Option<String> {
    self.events.iter().rev().find_map(|entry| match &entry.event {
        AgentEvent::AssistantText { text, .. } => {
            crate::headless_terminal::bound_waiting_prompt(text)
        }
        _ => None,
    })
}
```

Add this field to `AgentSessionRecord`:

```rust
pub last_assistant_prompt: Option<String>,
```

Initialize it to `None` for a new spawn in `commands.rs`. In `adoption.rs`, read it before moving the journal into `AgentShared`:

```rust
let last_assistant_prompt = journal.latest_assistant_prompt();
```

and set the record field:

```rust
last_assistant_prompt,
```

In `process_event` in `readers.rs`, update the record before deriving status:

```rust
if let AgentEvent::AssistantText { text, .. } = &event {
    record.last_assistant_prompt = kanna_daemon::headless_terminal::bound_waiting_prompt(text);
}
```

- [ ] **Step 4: Include the prompt in agent-mode status transitions**

Add in `crates/daemon/src/agent_runtime.rs`:

```rust
fn status_changed_event(
    session_id: &str,
    status: SessionStatus,
    waiting_prompt_snippet: Option<String>,
) -> Event {
    Event::StatusChanged {
        session_id: session_id.to_string(),
        status,
        waiting_prompt_snippet: if matches!(status, SessionStatus::Waiting | SessionStatus::Idle) {
            waiting_prompt_snippet
        } else {
            None
        },
    }
}
```

Change `set_status` to accept the prompt and broadcast the helper result:

```rust
fn set_status(
    record: &mut AgentSessionRecord,
    broadcast_tx: &broadcast::Sender<String>,
    session_id: &str,
    status: SessionStatus,
    waiting_prompt_snippet: Option<String>,
) {
    if record.status == status {
        return;
    }
    record.status = status;
    broadcast_event(
        broadcast_tx,
        &status_changed_event(session_id, status, waiting_prompt_snippet),
    );
}
```

In `readers.rs`, pass `record.last_assistant_prompt.clone()` for waiting/idle statuses and `None` for busy. Pass the stored value when child exit changes to idle. Spawn and permission-resolution busy events pass `None`. Kill lifecycle's final idle event uses the record's last assistant prompt.

- [ ] **Step 5: Run agent runtime tests and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon agent::tests
cargo test -p kanna-daemon agent_runtime
```

Expected: all agent journal/status tests pass, including adoption and permission bookkeeping tests.

---

### Task 3: Persist Changed Waiting Prompts in Kanna Server and Expose the LAN Contract

**Files:**
- Modify: `crates/kanna-server/src/db/pipeline_items.rs:175-230,500-575`
- Modify: `crates/kanna-server/src/db/tests.rs:470-590`
- Modify: `crates/kanna-server/src/terminal_watcher.rs:1-110,200-460`
- Modify: `crates/kanna-server/src/mobile_api.rs:50-85,365-425,830-890`
- Modify: `apps/mobile/src/lib/api/types.ts:65-85`
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [ ] **Step 1: Write failing database and watcher tests**

Add to `crates/kanna-server/src/db/tests.rs`:

```rust
#[test]
fn waiting_prompt_update_is_change_aware() {
    let unique = unique_name("waiting-prompt-update");
    let db = Db::open_for_tests(&Db::test_db_path(&unique)).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Original prompt",
        Some("Current title"),
        "in progress",
        "2026-07-11 00:00:00",
    )
    .unwrap();

    assert!(db
        .update_pipeline_item_waiting_prompt("task-1", "Ready for review")
        .unwrap());
    assert!(!db
        .update_pipeline_item_waiting_prompt("task-1", "Ready for review")
        .unwrap());
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .last_output_preview
            .as_deref(),
        Some("Ready for review")
    );
}
```

Add to `terminal_watcher.rs` tests, using the existing `seed_plain_task`, fake daemon listener, and timeout helpers:

```rust
#[tokio::test]
async fn watcher_persists_waiting_prompt_from_status_event() {
    let unique = unique_name("terminal-watcher-waiting-prompt");
    let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
    let config = test_config(&unique, &daemon_dir);
    seed_plain_task(&config);
    let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

    let server = tokio::spawn(async move {
        let mut subscriber = expect_subscribe(&listener).await;
        write_event(
            &mut subscriber,
            &DaemonEvent::StatusChanged {
                session_id: "task-child".to_string(),
                status: kanna_daemon::protocol::SessionStatus::Idle,
                waiting_prompt_snippet: Some("Ready for review".to_string()),
            },
        )
        .await;
        write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
    });

    terminal_state_watcher_once(
        &http_api::AppState::new(config.clone()),
        &session_replacements::SessionReplacements::default(),
    )
    .await
    .unwrap();
    server.await.unwrap();

    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        db.get_pipeline_item("task-child")
            .unwrap()
            .unwrap()
            .last_output_preview
            .as_deref(),
        Some("Ready for review")
    );
    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(daemon_dir);
}
```

- [ ] **Step 2: Run server tests and verify RED**

Run:

```bash
cargo test -p kanna-server waiting_prompt_update_is_change_aware
cargo test -p kanna-server watcher_persists_waiting_prompt
```

Expected: compilation fails because the DB update method and watcher branch do not exist.

- [ ] **Step 3: Add change-aware persistence and watcher handling**

Add to `Db` in `pipeline_items.rs`:

```rust
pub fn update_pipeline_item_waiting_prompt(
    &self,
    id: &str,
    prompt: &str,
) -> Result<bool, rusqlite::Error> {
    let Some(task_id) = self.resolve_pipeline_item_id(id)? else {
        return Ok(false);
    };
    let changed = self.conn.execute(
        "UPDATE pipeline_item
         SET last_output_preview = ?, updated_at = datetime('now')
         WHERE id = ?
           AND closed_at IS NULL
           AND COALESCE(last_output_preview, '') != ?",
        (prompt, &task_id, prompt),
    )?;
    Ok(changed > 0)
}
```

Add this helper near `persist_exit_resume_session_id` in `terminal_watcher.rs`:

```rust
fn persist_waiting_prompt(
    state: &http_api::AppState,
    session_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Ok(());
    }
    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    if db
        .update_pipeline_item_waiting_prompt(session_id, prompt)
        .map_err(|error| format!("db error: {error}"))?
    {
        state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    }
    Ok(())
}
```

Add this match arm before `Exit` in the watcher loop:

```rust
DaemonEvent::StatusChanged {
    session_id,
    waiting_prompt_snippet: Some(prompt),
    ..
} => {
    if let Err(error) = persist_waiting_prompt(state, &session_id, &prompt) {
        log::warn!(
            "failed to persist waiting prompt for {}: {}",
            session_id,
            error
        );
    }
}
```

- [ ] **Step 4: Add a backward-compatible explicit LAN/API field**

In both Rust `TaskSummary` and `TaskDetail`, retain `snippet` for existing CLI consumers and add:

```rust
pub waiting_prompt_snippet: Option<String>,
```

At each existing summary/detail struct literal, bind the compatibility value once immediately before the literal:

```rust
let waiting_prompt_snippet = item.last_output_preview.clone();
```

Then replace the existing `snippet: item.last_output_preview.clone()` member with these two explicit members, leaving every other existing member unchanged:

```rust
TaskSummary {
    snippet: waiting_prompt_snippet.clone(),
    waiting_prompt_snippet,
}
```

Add the explicit mobile model field in `apps/mobile/src/lib/api/types.ts` and retire the generic field from mobile code:

```ts
export interface TaskSummary {
  id: string;
  repoId: string;
  repoName?: string | null;
  title: string;
  stage: string | null;
  waitingPromptSnippet?: string | null;
  agentProvider?: string | null;
  agentType?: "pty" | "agent" | null;
}
```

Update LAN/client fixtures to use `waitingPromptSnippet: "Ready for review"` and assert the new JSON field. Keep Rust CLI serialization tests for legacy `snippet` passing.

- [ ] **Step 5: Run server and mobile API tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server waiting_prompt
pnpm --dir apps/mobile test src/lib/api/client.test.ts src/lib/transports/lanTransport.test.ts
```

Expected: all selected tests pass; LAN task JSON includes both legacy `snippet` and explicit `waitingPromptSnippet`.

---

### Task 4: Carry Waiting Prompts Through Cloud and Remote Desktop Snapshots

**Files:**
- Modify: `apps/desktop/src/utils/cloudTaskSnapshot.ts:1-75`
- Modify: `apps/desktop/src/utils/cloudTaskSnapshot.test.ts:1-90`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts:15-50,275-315`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts:15-105`
- Modify: `apps/mobile/src/lib/firebase/taskIndex.ts:15-40,180-205`
- Modify: `apps/mobile/src/lib/firebase/taskIndex.test.ts:35-110`
- Modify: `services/firebase-functions/src/types.ts:15-40`
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts:200-220`

- [ ] **Step 1: Write failing cloud snapshot mapping tests**

In `cloudTaskSnapshot.test.ts`, add `last_output_preview: "Ready for review"` to the task input and assert:

```ts
expect(snapshot).toMatchObject({
  promptSnippet: "Fix cloud mobile task list",
  waitingPromptSnippet: "Ready for review"
});
```

In `apps/mobile/src/lib/firebase/taskIndex.test.ts`, change the mapping fixture to include distinct values and assert only the waiting prompt enters the mobile summary:

```ts
const mapped = mapCloudTaskSnapshot({
  cloudTaskId: "cloud-task-1",
  ownerDesktopId: "desktop-1",
  ownerLocalTaskId: "task-1",
  title: "Prompt-derived title",
  promptSnippet: "Original task prompt",
  waitingPromptSnippet: "Ready for review",
  displayName: "Current editable title",
  stage: "in progress",
  status: "active",
  repo: { cloudRepoId: "repo-1", name: "kanna" },
  updatedAt: "2026-07-11T00:01:00.000Z",
  closedAt: null
});

expect(mapped.title).toBe("Current editable title");
expect(mapped.waitingPromptSnippet).toBe("Ready for review");
expect(mapped).not.toHaveProperty("snippet");
```

In `desktopCloudTaskIndex.test.ts`, assert a remote snapshot with `waitingPromptSnippet: "Ready for review"` produces:

```ts
expect(snapshot.items[0]?.last_output_preview).toBe("Ready for review");
```

- [ ] **Step 2: Run cloud mapping tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test utils/cloudTaskSnapshot.test.ts services/desktopCloudTaskIndex.test.ts
pnpm --dir apps/mobile test src/lib/firebase/taskIndex.test.ts
```

Expected: assertions fail because cloud snapshots do not carry `waitingPromptSnippet`, and mobile still maps original `promptSnippet` into `snippet`.

- [ ] **Step 3: Add the separate cloud field and mappings**

Include `last_output_preview` in `CloudTaskSnapshotInput.item` and add to the returned snapshot in `cloudTaskSnapshot.ts`:

```ts
waitingPromptSnippet: input.item.last_output_preview?.trim() || null,
```

Add the optional field to cloud reader contracts for backward compatibility:

```ts
waitingPromptSnippet?: string | null;
```

Map it in mobile `mapCloudTaskSnapshot`:

```ts
waitingPromptSnippet: snapshot.waitingPromptSnippet ?? undefined,
```

and in desktop `mapDesktopCloudTasks`:

```ts
last_output_preview: snapshot.waitingPromptSnippet ?? null,
```

Add nullable `waitingPromptSnippet` to `services/firebase-functions/src/types.ts` and set it to `null` in deterministic relay/E2E fixtures that construct complete snapshots.

- [ ] **Step 4: Run cloud mapping tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test utils/cloudTaskSnapshot.test.ts services/desktopCloudTaskIndex.test.ts services/desktopCloudPublisher.test.ts
pnpm --dir apps/mobile test src/lib/firebase/taskIndex.test.ts
```

Expected: all selected tests pass; original and waiting prompts remain distinct, and editable `displayName` wins for title.

---

### Task 5: Coalesce Per-Task Waiting Prompt Firestore Publication

**Files:**
- Create: `apps/desktop/src/services/waitingPromptPublishQueue.ts`
- Create: `apps/desktop/src/services/waitingPromptPublishQueue.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts:1-65,290-360,485-515`
- Modify: `apps/desktop/src/services/desktopCloudPublisher.ts:55-90`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/App.vue:65-80`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/windowWorkspace.ts:40-340`
- Modify: `apps/desktop/src/App.test.ts:55-80,680-770`
- Create: `crates/kanna-server/src/http_api/window_workspace.rs`
- Modify: `crates/kanna-server/src/db/settings.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`

- [ ] **Step 1: Write failing fake-timer queue tests**

Create `waitingPromptPublishQueue.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaitingPromptPublishQueue } from "./waitingPromptPublishQueue";

describe("waiting prompt publish queue", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces task changes and publishes only the newest value", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.schedule("task-1", "first");
    await vi.advanceTimersByTimeAsync(4_000);
    queue.schedule("task-1", "newest");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith("task-1", "newest");
  });

  it("deduplicates successful values and cancels closed tasks", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const queue = createWaitingPromptPublishQueue({ delayMs: 5_000, publish });

    queue.seed("task-1", "published");
    queue.schedule("task-1", "published");
    queue.schedule("task-2", "pending");
    queue.cancel("task-2");
    await vi.runAllTimersAsync();

    expect(publish).not.toHaveBeenCalled();
  });

  it("does not mark failed values as published", async () => {
    vi.useFakeTimers();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const queue = createWaitingPromptPublishQueue({
      delayMs: 5_000,
      publish,
      onError
    });

    queue.schedule("task-1", "retry me");
    await vi.runAllTimersAsync();
    queue.schedule("task-1", "retry me");
    await vi.runAllTimersAsync();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the queue test and verify RED**

Run:

```bash
pnpm --dir apps/desktop test services/waitingPromptPublishQueue.test.ts
```

Expected: FAIL because the queue module does not exist.

- [ ] **Step 3: Implement the isolated trailing queue**

Create `waitingPromptPublishQueue.ts`:

```ts
export interface WaitingPromptPublishQueue {
  seed(taskId: string, value: string | null): void;
  schedule(taskId: string, value: string): void;
  cancel(taskId: string): void;
  dispose(): void;
}

export function createWaitingPromptPublishQueue(options: {
  delayMs: number;
  publish(taskId: string, value: string): Promise<void>;
  onError?(error: unknown): void;
}): WaitingPromptPublishQueue {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastPublished = new Map<string, string | null>();

  const cancel = (taskId: string) => {
    const timer = timers.get(taskId);
    if (timer) clearTimeout(timer);
    timers.delete(taskId);
  };

  return {
    seed(taskId, value) {
      lastPublished.set(taskId, value);
    },
    schedule(taskId, value) {
      if (lastPublished.get(taskId) === value) return;
      cancel(taskId);
      timers.set(taskId, setTimeout(() => {
        timers.delete(taskId);
        void options.publish(taskId, value)
          .then(() => lastPublished.set(taskId, value))
          .catch((error) => options.onError?.(error));
      }, options.delayMs));
    },
    cancel,
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      lastPublished.clear();
    }
  };
}
```

- [ ] **Step 4: Wire only changed open-task prompts into per-task publication**

Import `publishDesktopWaitingPromptSnippet` and the queue in `useAppCloudWorkspace.ts`. Construct one queue after local state declarations:

```ts
const waitingPromptPublishQueue = createWaitingPromptPublishQueue({
  delayMs: 5_000,
  publish: async (taskId, value) => {
    const item = store.items.find((candidate) => candidate.id === taskId);
    if (!item || item.closed_at !== null) return;
    await publishDesktopWaitingPromptSnippet({
      localRepoId: item.repo_id,
      ownerLocalTaskId: item.id,
      waitingPromptSnippet: value
    });
  },
  onError: (error) => {
    console.warn("[cloud] failed to publish waiting prompt:", error);
    showCloudBackendErrorToast(error);
  }
});
```

Watch only stable prompt identities, not `updated_at` or output:

```ts
watch(
  () => store.items.map((item) => ({
    id: item.id,
    closedAt: item.closed_at,
    prompt: item.last_output_preview
  })),
  (items, previous = []) => {
    const previousById = new Map(previous.map((item) => [item.id, item]));
    for (const item of items) {
      if (item.closedAt !== null) {
        waitingPromptPublishQueue.cancel(item.id);
        continue;
      }
      if (desktopAuthState.value.status !== "signedIn" || !item.prompt) continue;
      if (previousById.get(item.id)?.prompt !== item.prompt) {
        waitingPromptPublishQueue.schedule(item.id, item.prompt);
      }
    }
  }
);
```

After a successful sign-in reconcile, seed every open task's current value so startup does not republish it:

```ts
for (const item of store.items) {
  if (item.closed_at === null) {
    waitingPromptPublishQueue.seed(item.id, item.last_output_preview);
  }
}
```

Call `waitingPromptPublishQueue.dispose()` from `disposeDesktopCloudWorkspace()`.

Implement `publishDesktopWaitingPromptSnippet` as an `updateDoc` of only the
`waitingPromptSnippet` field on an existing matching task. Serialize it with
structural reconciles in the publisher module so delayed full snapshots cannot
roll back a newer rename or prompt. Capture the values actually reconciled and
seed only values that are still unchanged when reconciliation completes.

Pass the window workspace controller from `App.vue`. Elect the first live
window in persisted workspace order as the sole local cloud publisher, gate
initial reconciliation, structural watchers, and waiting-prompt scheduling on
that reactive ownership state, and emit a membership invalidation on window
open/close. When the owner closes, the next window takes ownership and performs
one current-state reconcile. Reset the sign-in reconcile guard on sign-out so
returning to the same account republishes changes made while signed out.

Before an owning window removes itself, fence new cloud publications, cancel
queued prompt work, and drain the serialized write tail. Only then mutate
membership and emit the event that allows a successor to publish. If close
fails, reopen publication and re-elect without stealing ownership from an
already-live earlier window. Bound the drain to five seconds; on timeout,
cancel the close and restore the prior publisher instead of allowing old and
new owners to overlap. If both membership restoration and election reads fail,
use the pre-close ownership value as the temporary fallback.

Replace cross-window whole-snapshot read/modify/write with typed, narrow
`/v1/window-workspace/mutations` operations. Apply each operation in a
server-side SQLite `BEGIN IMMEDIATE` transaction. Removal includes the caller's
observed ids and current Tauri live ids so it can prune windows proven stale
while preserving windows opened concurrently. Wait for a new Tauri Webview's
`tauri://created` event, but let that Webview alone ensure its persisted
membership. Register its close handler first, stop initialization when close
has begun, and have the opener perform no ensure that could recreate a child
after the child removes itself.

Remove task creation's direct Firestore publisher. Keep immediate LAN
publication and the shared `createItem` invalidation; the elected owner reloads
that state and performs the structural cloud reconcile.

- [ ] **Step 5: Run queue and cloud workspace tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test services/waitingPromptPublishQueue.test.ts App.test.ts
```

Expected: queue tests pass; cloud sign-in/reconcile tests still pass without
extra periodic calls; secondary windows perform no Firestore writes; re-auth
reconciles again; and deferred structural/prompt writes preserve the newest
values regardless of completion order. A transient failure receives one
delayed retry, while a persistent outage stops after that bounded retry. Owner
close waits for in-flight writes before successor election, and concurrent
workspace mutations neither resurrect a closed window nor erase a newly
created one. Offline drains cancel close after a bounded wait, failed recovery
retains the prior owner, and secondary task creation performs no direct
Firestore write. An A→B→A prompt change is also corrected when B has already
started publishing, so a stale in-flight write cannot become the lasting cloud
value.

---

### Task 6: Simplify Mobile Cards and Apply Exact Title/Prompt Bounds

**Files:**
- Modify: `apps/mobile/src/screens/taskPresentation.ts:1-60`
- Modify: `apps/mobile/src/screens/taskPresentation.test.ts:1-105`
- Modify: `apps/mobile/src/components/TaskCard.tsx:1-105`
- Create: `apps/mobile/src/components/TaskCard.test.tsx`
- Modify: `apps/mobile/src/components/TaskList.tsx:1-60`
- Modify: `apps/mobile/src/screens/TasksScreen.tsx:1-95`
- Modify: `apps/mobile/src/screens/TasksScreen.test.tsx`
- Modify: `apps/mobile/src/state/sessionStore.ts:175-205`
- Update: mobile transport/controller tests containing `snippet` fixtures

- [ ] **Step 1: Write failing presentation tests for exact card semantics**

Replace the list-item tests in `taskPresentation.test.ts` with:

```ts
describe("buildTaskListItemModel", () => {
  it("shows the current title and waiting prompt", () => {
    const model = buildTaskListItemModel({
      id: "task-1",
      repoId: "repo-1",
      title: "Current editable title",
      stage: "in progress",
      waitingPromptSnippet: "Ready for review"
    });

    expect(model).toEqual({
      stageLabel: "in progress",
      title: "Current editable title",
      waitingPromptSnippet: "Ready for review",
      isWaitingPromptPlaceholder: false
    });
  });

  it("uses a muted ellipsis before the first waiting prompt", () => {
    const model = buildTaskListItemModel({
      id: "task-2",
      repoId: "repo-1",
      title: "New task",
      stage: "in progress"
    });

    expect(model.waitingPromptSnippet).toBe("…");
    expect(model.isWaitingPromptPlaceholder).toBe(true);
  });

  it("bounds title and prompt including the ellipsis without splitting surrogates", () => {
    const model = buildTaskListItemModel({
      id: "task-3",
      repoId: "repo-1",
      title: "😀".repeat(81),
      stage: "review",
      waitingPromptSnippet: "界".repeat(241)
    });

    expect(Array.from(model.title)).toHaveLength(80);
    expect(model.title.endsWith("…")).toBe(true);
    expect(Array.from(model.waitingPromptSnippet)).toHaveLength(240);
    expect(model.waitingPromptSnippet.endsWith("…")).toBe(true);
  });
});
```

Create `TaskCard.test.tsx` with a complete React Native host mock and assert the removed labels are absent:

```tsx
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

let TaskCard: typeof import("./TaskCard").TaskCard | null = null;

beforeAll(async () => {
  TaskCard = (await import("./TaskCard")).TaskCard;
});

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    [key: string]: unknown;
  };
}

function textContent(node: ElementNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const children = node.props?.children;
  const values = Array.isArray(children) ? children : children ? [children] : [];
  return values.map(textContent).join("");
}

describe("TaskCard", () => {
  it("renders only stage, bounded title, and waiting prompt", () => {
    if (!TaskCard) throw new Error("TaskCard was not loaded");
    const tree = TaskCard({
      task: {
        id: "task-1",
        repoId: "repo-1",
        title: "Current title",
        stage: "review",
        waitingPromptSnippet: "Please confirm the final UI."
      },
      onPress: vi.fn()
    }) as ElementNode;

    const text = textContent(tree);
    expect(text).toContain("Current title");
    expect(text).toContain("review");
    expect(text).toContain("Please confirm the final UI.");
    expect(text).not.toContain("TASK");
    expect(text).not.toContain("RECENT");
    expect(text).not.toContain("repo-1");
  });
});
```

- [ ] **Step 2: Run focused mobile tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test src/screens/taskPresentation.test.ts src/components/TaskCard.test.tsx
```

Expected: model signatures/assertions fail and `TaskCard` still requires scope/repository props.

- [ ] **Step 3: Implement the bounded presentation model**

Replace the task-list model portion of `taskPresentation.ts` with:

```ts
import type { TaskSummary } from "../lib/api/types";

const TASK_TITLE_LIMIT = 80;
const WAITING_PROMPT_LIMIT = 240;

export interface TaskListItemModel {
  stageLabel: string;
  title: string;
  waitingPromptSnippet: string;
  isWaitingPromptPlaceholder: boolean;
}

export function truncateVisibleText(value: string, limit: number): string {
  const characters = Array.from(value.trim());
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, limit - 1).join("")}…`;
}

export function buildTaskListItemModel(task: TaskSummary): TaskListItemModel {
  const prompt = task.waitingPromptSnippet?.trim() ?? "";
  return {
    stageLabel: task.stage ?? "unknown",
    title: truncateVisibleText(task.title, TASK_TITLE_LIMIT),
    waitingPromptSnippet: prompt
      ? truncateVisibleText(prompt, WAITING_PROMPT_LIMIT)
      : "…",
    isWaitingPromptPlaceholder: !prompt
  };
}
```

Delete `TaskWorkspaceHeaderModel`, `buildTaskWorkspaceHeaderModel`, its import from `taskPresentation.test.ts`, and its complete test block. `rg` confirms these symbols have no production callers; no unrelated workspace helper is removed.

- [ ] **Step 4: Simplify `TaskCard`, `TaskList`, and `TasksScreen` props**

Change `TaskCardProps` and model construction to:

```tsx
interface TaskCardProps {
  task: TaskSummary;
  onPress(): void;
}

export function TaskCard({ task, onPress }: TaskCardProps) {
  const model = buildTaskListItemModel(task);
```

Remove `topRow`, `scopeLabel`, and `repoLabel` markup/styles. Render the remaining content as:

```tsx
<View style={styles.row}>
  <Text numberOfLines={2} style={styles.title}>{model.title}</Text>
  <View style={styles.stagePill}>
    <Text style={styles.stageLabel}>{model.stageLabel}</Text>
  </View>
</View>
<Text
  numberOfLines={3}
  style={[
    styles.preview,
    model.isWaitingPromptPlaceholder ? styles.previewPlaceholder : null
  ]}
>
  {model.waitingPromptSnippet}
</Text>
```

Add:

```ts
previewPlaceholder: {
  color: "#6F819E"
}
```

Remove `isRecentView` and `repoNameById` from `TaskListProps`, and pass only `task`/`onPress` to `TaskCard`. Remove the corresponding derived values and props from `TasksScreen`.

- [ ] **Step 5: Update mobile equality and fixtures to the explicit field**

Change task equality in `sessionStore.ts` from generic snippet comparison to:

```ts
(task.waitingPromptSnippet ?? null) ===
  (other.waitingPromptSnippet ?? null)
```

Update mobile controller, transport, Firebase, and presentation test fixtures from `snippet` to `waitingPromptSnippet`. Preserve terminal/agent detail behavior; the waiting prompt is a card summary field, not terminal content.

- [ ] **Step 6: Run the focused mobile suite and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test src/screens/taskPresentation.test.ts src/components/TaskCard.test.tsx src/screens/TasksScreen.test.tsx src/state/sessionStore.test.ts src/lib/firebase/taskIndex.test.ts
```

Expected: all selected tests pass, with no rendered card type or repo name and exact 80/240 bounds.

---

### Task 7: Verify the End-to-End Contract

**Files:**
- Verify only; fix failures in files already listed above.

- [ ] **Step 1: Run formatting checks**

Format the modified Rust sources, then run the checks:

```bash
cargo fmt --all
cargo fmt --all -- --check
git diff --check
```

Expected: both commands exit successfully with no formatting or whitespace errors.

- [ ] **Step 2: Run daemon and server suites**

Run:

```bash
cargo test -p kanna-daemon -- --test-threads=1
cargo test -p kanna-server
```

Expected: all daemon and server tests pass. Daemon tests run serially per repository guidance.

- [ ] **Step 3: Run desktop focused tests and typecheck**

Run:

```bash
pnpm --dir apps/desktop test utils/cloudTaskSnapshot.test.ts services/desktopCloudTaskIndex.test.ts services/desktopCloudPublisher.test.ts services/waitingPromptPublishQueue.test.ts App.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: focused desktop tests and Vue TypeScript checking pass.

- [ ] **Step 4: Run mobile suite and typecheck**

Run:

```bash
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
```

Expected: the complete mobile unit suite and TypeScript checking pass.

- [ ] **Step 5: Inspect final worktree scope**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only the approved daemon/server/cloud/mobile implementation, tests, design spec, and this plan are changed; no generated native mobile files, SQLite databases, or unrelated files appear.
