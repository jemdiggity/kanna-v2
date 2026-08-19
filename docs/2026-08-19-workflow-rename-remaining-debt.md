# "Pipeline" → "workflow": what was renamed, and what deliberately was not

*2026-08-19*

The product concept is a **workflow**. The codebase used to call it a
*pipeline*, and the rename has been landing in passes. This note records the
line the rename stops at, so the next person greping `pipeline` knows which
hits are debt and which are correct.

## The rule

> An identifier that names **the storage table or one of its columns** keeps
> saying `pipeline`. An identifier that names **the concept** says `workflow`.

`get_pipeline_item`, `NewPipelineItem`, `insertPipelineItem`, `PipelineRow`,
`pipeline_item_id` and friends all name the `pipeline_item` table, so they are
spelled after the table, not after the concept. `recent_repo_workflows`,
`normalize_workflow_definition`, `workflow_socket_path` and the rest name the
concept, so they say workflow.

## Deliberately left alone

- **`pipeline_item` table.** A table rename buys the least and risks the most:
  every query, every fixture, every `.sql` seed, every external SQL reader in
  the E2E suites. Renaming it also would not change one product-facing string.
- **`pipeline_item.pipeline`, `.pipeline_def`, `.initial_pipeline` columns**,
  and the `pipeline_item_id` foreign keys on `task_port`, `worktree`,
  `terminal_session`, `stage_run.task_id`, and the `idx_pipeline_item_*`
  indices. Same argument, plus a column rename is a migration whose only payoff
  is spelling.
- **Recorded migration ids** (`002_pipeline_item_metadata_columns`,
  `007_pipeline_stage_columns`, `023_stage_run_pipeline_snapshot`, …). These
  are rows in `schema_migrations` on every existing database; renaming one
  re-runs the migration.
- **The daemon socket directory `<daemon_dir>/pipeline`.** Part of the
  cross-version socket contract — a new app must still find a running daemon's
  socket. The Rust symbols around it already say workflow.
- **The desktop `PipelineItem` TS interface and `packages/db` row types**, which
  mirror the table one-for-one.

## Kept as deprecated aliases (never removed without a deprecation window)

These exist because a consumer we do not ship in lockstep — an older mobile
build, a peer desktop on an older release, a repo config written years ago —
may still be on the old spelling.

| Surface | Canonical | Legacy alias |
|---|---|---|
| Set-workflow route | `POST /v1/tasks/{id}/actions/set-workflow` | `…/actions/set-pipeline` |
| Repo workflow definition route | `…/kanna-definitions/workflows/{name}` | `…/kanna-definitions/pipelines/{name}` |
| Recent workflows route | `…/recent-workflows` | `…/recent-pipelines` |
| Create/set-workflow request key | `workflowName` | `pipelineName` |
| Task + child payload response key | `workflowName` | `pipelineName` (still emitted) |
| Repo definitions response keys | `workflows`, `defaultWorkflow` | `pipelines`, `defaultPipeline` (still emitted) |
| `workflow.changed` task event payload | `fromWorkflow` / `toWorkflow` | `fromPipeline` / `toPipeline` (still emitted) |
| Task transfer payload task field | `workflow` | `pipeline` (still emitted; either key parses) |
| Tauri stage-complete event | `workflow_stage_complete` | `pipeline_stage_complete` (still emitted) |
| Tauri command | `get_workflow_socket_path` | `get_pipeline_socket_path` |
| `.kanna/config.json` key | `workflow` | `pipeline` |
| Repo definition directory | `.kanna/workflows/` | `.kanna/pipelines/` |
| Repo command id | `factory:create-workflow` | `factory:create-pipeline` |

Legacy `pipeline_def` snapshots, and the `post_action` / `policy.execution:
"continue"` workflow JSON that compiles into stage posts at load time, keep
loading unchanged — see AGENTS.md.

## Not aliased, because nothing referenced the old name

The MCP tool catalog renamed `kanna_set_task_pipeline` → `kanna_set_task_workflow`
and `pipeline_name` → `workflow_name` outright, with no alias. Nothing in the
repo — no agent definition, no prompt, no doc — names the retired tool or
parameter, and the catalog is served fresh to every client from
`crates/kanna-tool-catalog`, so there is no pinned consumer to keep working.
Re-introducing the old names now would add surface rather than finish a rename.

## E2E coverage note

The one wire format this pass changed is the task-transfer payload, which now
emits `workflow` alongside `pipeline` and parses either. The **canonical** half
has real end-to-end coverage: `apps/desktop/tests/e2e/real/local-transfer-*.test.ts`
drive a genuine desktop-to-desktop transfer, and every one of them now builds
and imports a payload through the renamed field.

The **legacy** half — a payload arriving with only `pipeline` — has no E2E test
and cannot get one from this repo: the only producer of a `pipeline`-only
payload is a Kanna build older than this change, and the E2E harness runs two
instances of the *current* build. Covering it would mean hand-forging a payload,
which is exactly what
`transfer_engine::payload::tests::the_task_workflow_parses_from_either_key_and_re_encodes_under_both`
does. It would become E2E-testable if the transfer harness gained a way to pin
one side to a released older binary; until then the unit test is the contract.
