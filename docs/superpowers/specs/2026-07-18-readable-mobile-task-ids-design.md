# Readable Mobile Task IDs Design

## Goal

New tasks created from the mobile app use the same eight-character lowercase
hexadecimal durable IDs as tasks created from the desktop app. Existing tasks
with longer IDs remain unchanged.

## Design

Keep the existing client-generated task ID and retry flow. Change only the
mobile ID generator so every generation path returns exactly eight lowercase
hexadecimal characters:

- When `crypto.randomUUID()` is available, remove separators and use eight hex
  characters.
- When `crypto.getRandomValues()` is available, read four random bytes and
  encode them as hex.
- In React Native runtimes without either API, combine the existing timestamp,
  process-local counter, and `Math.random()` inputs into a 32-bit value and
  encode it as eight hex characters.

The frozen ID remains part of `PendingTaskCreation`, so retries and recovery
continue to submit the same ID. The server already accepts eight-character
lowercase hexadecimal requested IDs and handles collisions as conflicts. A
server response stating that the ID belongs to different task data is
classified as definitely not created, which clears the frozen attempt and lets
the next submission generate a fresh ID. Other conflicts and ambiguous
transport failures retain the existing recovery behavior.

No migration, alias, or UI truncation is added. Branch and worktree names for
new mobile tasks naturally become `task-<8 hex characters>`.

## Testing

Add focused mobile controller tests proving that task creation submits an
eight-character lowercase hexadecimal ID when cryptographic UUID generation is
available and when the React Native fallback is used. Retain the existing
recovery tests to prove retries reuse the frozen ID. Add transport and client
tests proving that confirmed ID collisions preserve their server detail and are
classified as definitely not created.
