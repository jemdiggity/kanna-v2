# Agent-friendly task-event cursors

## Goal and owner directive

Make `kanna_wait_events` cursors short and safely retypable for an LLM caller without weakening the feed's lossless checkpoint contract. Owner directive, 2026-08-24 (voice, paraphrased in the task prompt): Kanna is moving from human UX to agent UX; an agent should not have to reproduce a roughly 400-character opaque cursor when an approximately eight-hex-digit handle would do.

## Scope and design

- Return short, process-local, server-issued cursor handles from both `kanna-server` (native and `ks1` waits) and `kanna-mcp` (`km1` task-id fan-in). Store the full checkpoint behind each handle with a 10-minute TTL and bounded GC. Handles are deliberately restart-local; an unknown or expired handle must say to restart without a cursor and replay retained history.
- Keep numeric, `p1`, `p3`, `kc1`, `ks1`, and `km1` cursors accepted as deprecated compatibility inputs. A successful legacy resume upgrades its response to a short handle.
- Preserve immutable checkpoint behavior: every response handle denotes exactly the full cursor state produced by that call, so handing it to the next call cannot miss intervening events. Do not mutate an already-issued checkpoint in place.
- Treat an invalid embedded per-machine cursor as a poisoned aggregate checkpoint, not an ordinary retryable machine outage: fail actionably and require a cursor-less restart instead of returning a continuation that wedges forever. Ordinary machine failures remain partial and retain their checkpoint.
- Update the endpoint/tool documentation and cover continuity, expiry/corruption, legacy compatibility, and multi-machine partial failure in server and MCP tests.

The alternatives were rejected as follows: a compact stateless grammar cannot stay both short and lossless because current-activity paging needs a settled task-id boundary and aggregation needs an independent cursor per machine; implicit MCP-only “last cursor” state is ambiguous for concurrent waits and would leave direct HTTP/server aggregation exposed. Explicit immutable handles make the checkpoint selected by each call unambiguous.

Out of scope: changing event retention, ordering, paging, debounce behavior, task scope semantics, or fixing unrelated catalog surfaces.

## Follow-up candidates from the tool-catalog audit

- `machine_id` is a potentially long relay-issued identifier repeated across calls; a scoped short alias could improve agent use.
- `repo_remote_url_hash` is a long hash that agents may copy from `kanna_list_repos` into later calls; a stable short repository identity could avoid verbatim round-tripping.
- Full branch names, PR URLs, and provider resume/run identifiers appear in responses and may be copied into later operations, but are less acute because task-id-based tools usually avoid requiring them.

## Done when

Focused Rust tests prove lossless call-to-call continuity, clear corrupt/expired-handle recovery, acceptance and upgrade of old cursor formats, and that a bad embedded per-machine cursor cannot produce a permanently wedged aggregate continuation; formatting and clippy pass for the changed crates.

## Revision 1

Reviewer feedback delivered 2026-08-24 requires the server-side `ks1` HTTP aggregation path to fail actionably when a routed machine rejects its embedded cursor while retaining partial results for ordinary peer failures, with real routed-HTTP integration coverage in both `kanna-server` and `kanna-mcp`. It also requires the typed `kanna-cli task wait-events` surface and request builder to expose the catalog's `short_cursor` / `shortCursor` parameter, with CLI/catalog contract tests. Completion requires the focused server, MCP, and CLI tests plus `./kd test all`.
