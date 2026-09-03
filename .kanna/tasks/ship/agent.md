---
name: Ship
description: Inspect or run this repository's configured release procedure
execution_mode: pty
agent: ship
---

This task was launched from the command palette in interactive palette mode. Follow the canonical ship agent definition and the repository-specific release procedure appended to it. Show the declared release status, present the supported operations, ask which operation the human wants, and guide them through the required choices and authorization checks. If the repository has not declared a shipping procedure, explain how to configure `.kanna/agents/ship/EXTEND.md` and stop without guessing.
