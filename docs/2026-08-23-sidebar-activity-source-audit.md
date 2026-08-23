# Sidebar activity source audit (2026-08-23)

## Conclusion

The stale-working-until-click defect reported through staging `.4` is fixed in
the currently served `0.3.0-staging.6`. The sidebar and
`task.activity_changed` feed do not maintain independent activity values: both
derive from `pipeline_item.activity`. They use different delivery mechanisms
and intentionally different timing, but neither computes a competing state.

No residual source-of-truth gap was found, so this audit makes no production
code change.

## Exact paths

### Daemon status to the shared database value

1. The daemon classifies the rendered terminal and publishes
   `StatusChanged`. For Codex, `HeadlessTerminal::status_frame_complete` in
   `crates/daemon/src/headless_terminal.rs` suppresses classification during a
   DEC synchronized-output redraw, while the independent quiet-status pass in
   `crates/daemon/src/session.rs` guarantees a completed idle frame eventually
   wins even if cosmetic output keeps repainting.
2. `terminal_state_watcher_once` in
   `crates/kanna-server/src/terminal_watcher.rs` receives the daemon event and
   calls `apply_watcher_runtime_status`. That records `runtime_status` and maps
   the same daemon verdict to the blended display value through
   `http_api::task_activity::activity_for_runtime_status`.
3. An attached terminal reports the same daemon status through
   `apps/desktop/src/composables/terminalSessionLifecycle.ts` →
   `terminalRuntimeStatusSink.ts` → `stores/init.ts` →
   `stores/sessions.ts::applyTaskRuntimeStatus` →
   `POST /v1/tasks/{id}/actions/runtime-status` →
   `crates/kanna-server/src/http_api/task_activity.rs::apply_runtime_status`.
   This path exists because the attached desktop knows whether the task is
   selected. It still writes the server-owned columns; it does not patch the
   sidebar store directly.
4. Both server paths call
   `Db::update_pipeline_item_activity` →
   `update_open_pipeline_item_activity` in
   `crates/kanna-server/src/db/pipeline_items.rs`. That single transaction
   updates `pipeline_item.activity`, `activity_changed_at`, and
   `activity_revision`, and arms the event debounce.

### Shared database value to the sidebar

1. Every successful watcher/runtime-status activity change publishes KSP
   `StateChanged { scope: Tasks }` from `kanna-server`.
2. `apps/desktop/src/stores/init.ts` subscribes with
   `getSharedStreamClient().onStateChanged`. Its trailing coordinator calls
   `reloadSnapshot`; every authenticated reconnect generation also queues a
   catch-up reload because `StateChanged` itself has no replay cursor.
3. `apps/desktop/src/stores/queries.ts::reloadSnapshot` calls
   `fetchDesktopSnapshot`, i.e. `GET /v1/snapshot`, and replaces the base
   snapshot before reconciling `taskUiSlots` authoritatively.
4. `crates/kanna-server/src/http_api/snapshot.rs::get_snapshot` calls
   `Db::ui_snapshot`; `crates/kanna-server/src/db/snapshot.rs` selects
   `pipeline_item.activity` and `activity_revision` directly.
5. `useAppCloudWorkspace.ts` builds the local workspace from `store.items`,
   projects it through `projectWorkspaceTasksForSidebar.ts`, and passes the
   resulting `sidebarItems` to `Sidebar.vue`. `Sidebar.vue` uses only
   `item.activity`: `working` is italic, `unread` is bold, and `idle` is normal.

There is no task-detail-to-sidebar hydration. `MainPanel.vue` refetches detail
when the selected id/activity revision/stage changes, but stores that result in
its private `taskDetail` ref. Clicking can visibly change `unread` to `idle`
because `stores/selection.ts` deliberately marks a selected unread task read
after a one-second dwell, or because attaching its terminal reports the current
idle status with `selected: true`. Those are authoritative writes to the same
DB row, not a stale sidebar snapshot being repaired from task detail.

### Shared database value to the task-event feed

The same `update_open_pipeline_item_activity` call records
`activity_event_baseline` and `activity_event_pending_at`. The server's
`activity_event_debounce_loop` calls
`Db::flush_debounced_activity_events`, which rereads the current
`pipeline_item.activity` and `runtime_status`; after the value remains stable,
it appends `TaskEventKind::ActivityChanged` with the previous/current activity
and runtime state. `Db::append_task_event` in `db/task_events.rs` inserts the
`task_event` row, and `GET /v1/task-events` in
`http_api/task_events.rs` reads those rows by sequence.

The feed therefore lags the sidebar snapshot by the configured debounce, by
design. A short transition may appear in the sidebar and produce no event if it
returns to the baseline before settling. A settled event cannot encode an
activity different from the database value used to create it. Later activity
can of course advance the snapshot after an older immutable event was appended.

## Empirical verification

### Current main dev build

Ran the canonical isolated real-desktop test:

```text
pnpm --dir apps/desktop test:e2e real/pty-runtime-status.test.ts
Test Files  1 passed (1)
Tests       3 passed (3)
Duration    24.24s
```

Its real daemon-backed false-Codex fixture keeps another task selected, starts
the subject without mounting its terminal, observes the daemon and store move
to `busy`/`working`, then asserts the still-unselected sidebar DOM changes from
italic `working` to bold `unread` as the daemon settles to idle. It does not
click or fetch detail for the subject before either sidebar assertion. The file
also proves attached busy-to-idle delivery and reconnect catch-up.

The first harness start encountered a transient GitHub timeout while the
vendored Ghostty build script fetched its pinned source. Retrying with that
pinned commit in a temporary `GHOSTTY_SOURCE_DIR` completed the same canonical
harness successfully. All harness-owned processes stopped.

Also ran these narrower shared-state regressions:

```text
cargo test -p kanna-server recorded_codex_idle_chrome_does_not_flap_server_activity_to_working
# 1 passed

cargo test -p kanna-server activity_changed_events_are_debounced_provider_neutral_and_bidirectional
# 1 passed
```

The first feeds the recorded Codex synchronized-redraw byte shape through the
daemon classifier and server DB mapping, observes idle/unread convergence, and
rejects a later false working flap. The second verifies stable bidirectional
activity changes generate `task.activity_changed` rows from that DB value.

### A/B attribution and shipped staging

Task e463bb8a landed as:

- `d1d47379e56e37b88fefe40d8257978d6f988e76` — fixed synchronized-frame
  classification and made the periodic settled-state check independent of the
  output throttle.
- `6288ddb94f4805e8a67734a704654b2139c014a4` — replaced reconstructed strings
  with the recorded Codex PTY byte shape.

The pre-fix `SessionHandle::refresh_quiet_status_at` shared the output
classification throttle, and `detect_headless_terminal_status_if_due` could
classify/consume that throttle during an incomplete synchronized redraw. The
fix changes exactly the failure mechanism behind a task remaining `working`
after reaching the idle composer; this is not merely a sibling sidebar fix.

The separate lossy-KSP catch-up protection predates it:
`e7a0b58754b087d5c245a86d730d7f4b6d0cc78c` added the authenticated-connection
generation refresh and the unselected-sidebar/reconnect E2E assertions.

Live release evidence collected with `kanna_info` and `./kd release status`:

- the connected server is staging on `127.0.0.1:48121`, reports
  `0.3.0-staging.6`, desktop id
  `desktop-21b320e8-a5ad-4fae-9d87-1db14090f0a9`;
- the installed signed `/Applications/Kanna Staging.app` also reports bundle
  version/build `0.3.0-staging.6` and has an August 22 Developer ID signature;
- `desktop-staging` serves commit
  `2401a9c56e4b1bcac997dfabeeb908ccb333021b`, published
  `2026-08-22T12:27:13Z`;
- both that commit and the preceding `.5` commit
  `79ceaf7f7d8ded43eb16c86886d2fe6dfea43a90` contain both e463bb8a commits by
  `git merge-base --is-ancestor`.

The signed release build does not expose the debug-only WebDriver endpoint, and
macOS denied this shell Accessibility access, so the installed window could not
be DOM-instrumented. The shipped-build conclusion rests on the live binary's
version/signature, the channel's immutable commit identity and ancestry, the
passing exact real-desktop E2E on the same source path, and the passing recorded
terminal/server regressions—not on an assumption that `.6` probably includes
the fix.
