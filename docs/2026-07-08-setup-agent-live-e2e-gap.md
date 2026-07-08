# Setup Agent Live E2E Gap

Phase 3 of `docs/specs/native-review.md` adds a built-in `setup` agent plus
mock coverage for the entry points: command palette launch and AddRepo import
launching a normal Kanna setup task.

A deeper end-to-end test that lets a real setup agent inspect a fixture repo,
answer its interview, write `.kanna/config.json`, write a pipeline, and then
exercise the generated GitHub flow is intentionally not automated yet.

That test needs a deterministic live-agent harness that can:

- provide a fake or disposable GitHub remote and `gh auth status` result;
- drive the setup agent's interactive questions without brittle terminal text
  matching;
- assert generated `.kanna/` files after the agent records completion;
- continue through `pr@draft-pr`, in-app review approval, `approve`, and
  `merge@github` without touching a real production repository.

Until that harness exists, coverage is split across contract tests for bundled
flavors, unit tests for setup task launching, a mock App import flow test, and
server-side built-in resolution tests.
