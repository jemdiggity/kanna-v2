# Generic ship agent unconfigured-path E2E gap

## Scope

This change separates the public, repository-agnostic `ship` contract from
Kanna's repo-local `kd` release procedure. It keeps the existing `ship` agent,
`custom:ship` command id, server catalog, desktop/mobile presentation, and task
creation wiring unchanged.

## Gap

The remaining behavior that cannot be proved offline is a live agent reading
the generic prompt in a repository with no `ship` extension, refusing to infer
a release procedure, and recording failure. That requires an authenticated
provider and would turn a deterministic definition check into a quota-bearing
agent-behavior test. The existing real desktop E2E lane proves command launch
wiring, but cannot deterministically assert an LLM's policy response.

## Narrower coverage

- Kanna-server definition tests prove the bundled base contains the
  unconfigured-stop rule and no Kanna `kd` commands.
- Kanna-server extension tests prove a repo snapshot appends its release
  procedure and can override provider order.
- Repository-command tests prove `custom:ship` still launches the generic
  interactive template.
- Desktop and CLI-contract tests prove the task template stays generic, the
  Kanna runbook remains in `EXTEND.md`, and the ship safety contract is shipped
  beside the agent definition.

## Closing the gap

Add a deterministic policy-evaluation harness that can execute bundled agent
prompts against a controlled provider fixture and inspect the recorded stage
result without external credentials or model variability. Then cover both an
unconfigured repository and one with a minimal `ship/EXTEND.md`.
