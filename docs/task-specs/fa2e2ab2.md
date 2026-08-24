# Agent-friendly task listings

Owner directive (2026-08-24, paraphrased from voice): make task-listing MCP calls default to the caller task's repository while preserving explicit cross-repository and `all_machines` use; include the durable latest-run agent name; bound listing prompts rather than returning full task prompts; and remove the byte-identical snippet duplication without breaking consumers.

Scope: add optional repository and limit controls to recent listings, repository-default augmentation for `kanna_list_recent_tasks` and `kanna_search_tasks`, bounded prompt summaries with full prompts retained by task detail, latest-run agent data in detail and list rows, compatibility-safe snippet canonicalization, and server/catalog/MCP/mobile plus client-server E2E coverage. Preserve existing per-endpoint ordering and multi-machine aggregation semantics. Do not address the separate chrome-leak contents of output snippets.

Done means repository filtering, default/override scoping, limits, prompt bounds, agent attribution, and compatibility aliases are documented and covered by proportionate tests, with Rust/TypeScript checks passing for touched surfaces.
