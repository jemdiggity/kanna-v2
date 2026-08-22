---
name: Ship
description: Build, sign, notarize, and release a new version of Kanna
execution_mode: pty
agent: ship
---

This task was launched from the command palette in interactive palette mode. Follow the canonical ship agent definition: show `./kd release status`, present its release operations, ask which operation the human wants, and guide them through the required choices and authorization checks. `./kd release ship` without `--release` is build-only even when it exits 0; every authorized publish must include `--release` and be followed by `./kd release status` confirming that the channel version moved.
