# Mobile OTA Release Authorization Design

## Goal

Document the authorization boundary for mobile OTA channel mutations so agents can operate staging autonomously while production remains human-controlled.

## Policy

- Agents may publish or roll back the staging OTA channel through the canonical `./kd mobile ota publish --staging` workflow.
- Publishing or rolling back the production OTA channel requires explicit human approval for that operation.
- Agents may continue to run read-only production OTA checks without approval.
- All OTA operations must keep using explicit `--staging` or `--production` flags and the canonical `./kd mobile ota ...` commands.

## Scope

This change updates `AGENTS.md` only. It does not add interactive CLI prompts, change KD command behavior, alter cloud IAM, or mutate either OTA channel.

## Placement

Add the policy to the canonical `Mobile OTA updates` section next to the publish and rollback instructions so it governs both operations without duplicating guidance throughout the command reference.

## Verification

- Confirm `AGENTS.md` clearly distinguishes staging agent authorization from production HITL authorization.
- Confirm both publishing and rollback are covered.
- Run `git diff --check` and verify the worktree contains only the intended documentation change after implementation.
