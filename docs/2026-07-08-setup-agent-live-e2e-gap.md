# Setup Agent Live E2E Gap

The built-in `setup` agent has mock coverage for the entry points: command
palette launch and AddRepo import launching a normal Kanna setup task.

A deeper end-to-end test that lets a real setup agent inspect a fixture repo,
answer its interview, write `.kanna/config.json`, and then exercise the
generated GitHub flow is intentionally not automated yet.

That test needs a deterministic live-agent harness that can:

- provide a fake or disposable GitHub remote and `gh auth status` result;
- drive the setup agent's interactive questions without brittle terminal text
  matching;
- assert generated `.kanna/` files after the agent records completion —
  including that the stock answer *selects* a built-in workflow
  (`no-review`, `single-reviewer`, or `specialized-reviewers`) plus
  `flavors.merge` rather than authoring a workflow file;
- continue through the ordinary `pr` stage, `approve`, and `merge@github`
  without touching a real production repository;
- exercise the incompatible-flavor guards, where the answers stop being
  independent: `pr@push-only` publishes no PR and so must drop the `approve`
  post onto a repo-local workflow instead of selecting a built-in, manual
  merge drops the post too, and `pr@draft-pr` with a merge agent needs the
  repo-local `approve` extension that readies the draft — `approve` fails on
  a missing PR and `merge@github` cannot merge a draft, so each of these
  strands the flow if setup composes them wrong.

Until that harness exists, coverage is split across contract tests for bundled
flavors and for the setup composition rules above
(`tests/cli-contract/tests/offline/agent-flavor-contracts.test.ts`), unit tests
for setup task launching, a mock App import flow test, and server-side built-in
resolution tests — including that the retired `qa` / `qa-dispatch` workflow
names still resolve for repos whose committed config selects them.
