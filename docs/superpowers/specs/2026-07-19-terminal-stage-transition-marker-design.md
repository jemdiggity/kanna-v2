# Terminal Stage Transition Marker Design

## Goal

Make stage boundaries immediately recognizable in a durable task's terminal scrollback by showing an ordered marker whenever Kanna replaces the current agent session with the next workflow stage.

## User Experience

When a task moves from one workflow stage to another, the next terminal section begins with an ANSI-styled separator whose label includes both stage names:

```text
━━ Stage advanced: in progress → review ━━
```

The marker appears before output from the newly launched agent. It remains part of the authoritative terminal history, so reconnecting, restarting the app, or viewing the task through a relayed terminal preserves the boundary.

Only a real stage transition emits this marker. Initial task creation, stage reruns, revision resumes, post dispatches and their fallback sessions, shell sessions, and workspace teardown sessions do not emit one.

## Architecture

The transition marker belongs to session initialization rather than to an individual frontend. `kanna-server` is the source of truth for stage transitions and knows both the departed and destination stage names. It will format the transition marker and attach it as an optional terminal prelude to the daemon spawn command for a prepared stage swap.

The daemon will accept the optional prelude on PTY session spawn commands. During session construction, it will write the prelude into the new headless terminal before the child process can produce output, then publish it through the same output stream used for process bytes. This gives snapshots and live clients one consistent ordering and avoids frontend races around `session_created` and attach snapshots. SDK/headless agent sessions have no terminal snapshot and render structured agent events, so they remain unchanged.

The prelude is a general session-spawn capability, but this change has one producer: true workflow stage swaps. All other spawn call sites omit it.

## Components and Data Flow

1. Stage preparation retains the source stage identity alongside the destination stage identity needed for the marker.
2. Stage-run spawning formats an ANSI-safe separator from those server-owned stage names and places it in the daemon spawn request.
3. The daemon initializes the new headless terminal with the prelude before launching or draining the agent process.
4. Attached clients receive the prelude before new agent output. Clients attaching later receive it in the serialized snapshot.

Stage names are treated as display text, not terminal control input. Formatting must strip or neutralize control characters before embedding names in ANSI output so repository-defined workflow names cannot inject terminal escape sequences or additional lines.

## Failure Behavior

The marker is presentation metadata and must not create a separate transition failure mode. Formatting is deterministic and in-memory. An absent prelude retains existing spawn behavior. If a session fails after its marker is initialized, existing daemon/session failure reporting remains authoritative.

## Testing

- Unit-test marker formatting, including the expected transition label and control-character sanitization.
- Verify a prepared true stage swap carries the source and destination stage identities required for the prelude.
- Verify non-transition spawn paths leave the prelude absent.
- Verify the daemon places the prelude in terminal history before process output and returns both in an attach snapshot.
- Run focused Rust tests for `kanna-server` and `kanna-daemon`, followed by the repository's broader Rust test command when practical.

## Non-Goals

- Adding clickable or DOM-rendered stage dividers over the terminal.
- Backfilling markers into terminal history from transitions completed before this feature ships.
- Marking posts, reruns, revision resumes, task creation, or task closure.
- Adding an equivalent stage divider to SDK/headless AgentView sessions.
- Adding user-configurable marker colors or text.
