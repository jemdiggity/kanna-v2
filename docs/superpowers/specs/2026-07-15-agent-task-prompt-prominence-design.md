# Agent Task Prompt Prominence Design

## Problem

Kanna currently composes a stage prompt by concatenating the selected agent's
base instructions before the stage-specific prompt. For providers without a
native system-prompt channel, the transport layer then places one `## Your
Task` heading before that entire composite.

The heading therefore introduces generic agent guidance rather than the
stage-specific assignment. In the default implementation stage, the user's
task appears only after the implement agent's generic instructions and its
completion section. Provider-discovered repository instructions and the Kanna
runtime preamble add more context before it, making a short assignment easy to
miss.

## Goals

- Place the stage-specific assignment immediately below `## Your Task`.
- Keep agent instructions and repository extensions intact in a separately
  labeled section.
- Preserve the established agent-instructions-first, stage-prompt-last order.
- Include the user's task exactly as many times as the workflow author
  requested through `$TASK_PROMPT`; Kanna must not add another copy.
- Apply one prompt structure consistently across Claude, Codex, Copilot,
  OpenCode, and Antigravity, in PTY and headless modes where supported.
- Preserve single-pass prompt-variable substitution.

## Non-goals

- Shortening the repository's `AGENTS.md` or changing provider-native project
  instruction discovery.
- Moving agent definitions into a provider's system-prompt channel.
- Reordering the task before agent instructions.
- Changing workflow stage behavior, transition policy, or completion rules.
- Repeating the task as a primacy or recency reminder. Resumed revisions keep
  their existing deliberate re-anchoring behavior.

## Prompt Structure

When both an agent body and a stage prompt are present, Kanna renders:

```markdown
## Agent Instructions

<agent definition body, including any repository EXTEND.md content>

## Your Task

<stage-specific prompt after variable substitution>
```

If only a stage prompt exists, Kanna emits only the `## Your Task` section. If
only an agent body exists, it emits only the `## Agent Instructions` section.
Empty sections are omitted, including a nonempty template whose variables
render entirely to whitespace.

The default implementation stage therefore ends with:

```markdown
## Your Task

<the user's original task>
```

The task remains the final section and is no longer separated from its heading
by generic completion boilerplate.

## Architecture and Data Flow

Section ownership moves to stage-prompt composition, where Kanna still has the
agent body and stage prompt as separate values. The live Rust builder and its
TypeScript mirror trim each source body, substitute it in one left-to-right
pass, omit it if the rendered body is blank, and then add the corresponding
heading. Inserted values are never rescanned.

Provider transport remains responsible only for combining Kanna runtime
guidance with the already composed user prompt:

- Claude keeps Kanna runtime guidance in its native appended system prompt and
  receives the sectioned stage prompt as the user message.
- Codex, Copilot, OpenCode, and Antigravity flatten the Kanna runtime guidance
  and sectioned stage prompt into one user message, as they do today.
- The shared flattening helpers recognize an outer Kanna section from the
  first nonblank line. They add a task heading for legacy or direct raw
  prompts, but preserve already-sectioned and agent-only prompts. Blank input
  adds no empty task section.

Live post continuations add their completion instruction to `## Agent
Instructions` before the post's `## Your Task` section. A fresh post fallback
does not receive that live-only instruction because its auto-stage Kanna
runtime preamble already carries the completion policy.

This boundary keeps provider adapters independent of workflow semantics while
preserving compatibility with raw prompts that do not pass through the stage
builder.

## Compatibility and Edge Cases

- `$TASK_PROMPT`, `$PREV_RESULT`, `$BRANCH`, `$BASE_REF`,
  `$SOURCE_WORKTREE`, and repository variables retain their current bindings.
  Headings are structural text and inserted values are never rescanned.
- For its reserved runtime variables, the TypeScript mirror recognizes the
  same bare-token boundaries and `${NAME}` spelling as Rust.
- Custom agent bodies and stage prompts remain byte-preserved apart from the
  existing outer trimming and the new surrounding headings.
- A user-authored `## Your Task` line inside prompt content is not removed or
  rewritten. Idempotence applies only to Kanna's outer transport framing.
- Explicit or legacy raw prompts continue to receive one `## Your Task`
  heading when flattened with Kanna runtime guidance.
- Agent-only prompts do not gain an empty task section, and stage-only prompts
  do not gain an empty instructions section.
- When an agent-less stage declares no prompt, its carried task is still
  labeled as `## Your Task` without rescanning the task value.
- Revision-resume messages are unchanged because they already place the
  original task and reviewer feedback near the start and intentionally avoid
  resending the full agent scaffold.

## Testing

Rust prompt-builder tests will pin exact output for prompts containing both
sections and for agent-only/stage-only cases. A regression assertion will show
that the actual stage assignment immediately follows `## Your Task` and occurs
after the generic agent completion text.

The TypeScript mirror will carry the same exact-output tests. Shared transport
tests will verify that an already sectioned prompt receives no duplicate task
heading, that an agent-only section does not gain an empty task section, and
that a raw prompt still receives one. Post-delivery tests will verify that the
completion policy precedes the task section while a fresh fallback does not
duplicate it. Existing spawn tests will continue to cover all supported
provider and execution-mode paths, with at least one live prepared-spawn
assertion checking the section order.

Focused Rust and TypeScript suites will run first, followed by the repository's
canonical broader checks when practical.
