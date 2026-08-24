# Task cb5eb2c6: mentioned-file partial availability

## Goal

Make mentioned-file resolution and presentation tolerate a mixed set of valid task-worktree paths and unavailable paths, so one invalid mention never hides valid files.

## Scope

- Resolve availability per mention at the server boundary, including a reason for unavailable paths, while retaining request-level failures for invalid batches or unavailable tasks/workspaces.
- On mobile, keep valid files openable and render unavailable mentions as disabled, grey rows with their reason.
- Give desktop a mentioned-files affordance. For a task local to this machine, any literal local absolute path that exists is clickable, including `/tmp`; render it in Kanna where supported and otherwise hand it to the OS. For a task viewed cross-machine, only workspace-served paths are clickable and other paths are disabled with a reason.
- Add mixed-batch mobile-to-server E2E coverage and focused unit/component coverage needed for the changed contracts.
- Amend `CLAUDE.md` so verification artifacts are saved under the in-worktree, gitignored `docs/task-specs/<task>-screenshots/` convention, described in text in the PR/task spec, and never committed.
- Gitignore task screenshot directories and remove the already-committed `04026ef3`, `2475a486`, and `c21c9405` screenshot directories from the branch tip while retaining their verification Markdown records.

## Constraints

- Paths outside the task worktree remain unavailable to mobile and remote desktop views and must never be served. A local desktop opens them directly from its trusted filesystem without involving the server.
- Existing request bounds, authentication, containment, and filesystem safety guarantees remain intact.
- Do not bump the mobile `runtimeVersion`; this is a JavaScript-only mobile change.
- Visually verify desktop clickable and unavailable states through `./kd dev up` and capture temporary evidence inside this worktree's gitignored screenshot directory.

## Done

A mixed in-workspace + `/tmp` server batch returns per-row outcomes; mobile and remote desktop views show valid workspace rows plus disabled unavailable rows; local desktop views make both existing local rows clickable; the boundary E2E and relevant checks pass; and the task spec records the inspected desktop states without committing screenshot binaries.

## Owner refinement

On 2026-08-24, the owner clarified: “Desktop should let you click files that are local. If it's a remote task, then within-workspace is reasonable.” This replaces the original desktop workspace-only availability rule; the mobile rule and inside-worktree artifact convention are unchanged.

Also on 2026-08-24, the owner decided that verification screenshots must not be committed. They live only while the worktree exists under `docs/task-specs/<task>-screenshots/`; the durable evidence is their written description in the PR/task spec. This replaces the task prompt's committed-directory bias and includes removing the three named legacy screenshot directories from the current tip.

## Verification record

On 2026-08-24, the real desktop app was run through `./kd dev up` and the new local mentioned-files E2E populated one existing workspace path, one existing `/tmp` path, and one missing `/tmp` path. The inspected capture showed both existing files at full contrast and the missing path greyed out with `Unavailable · File not found on this machine`; the E2E then opened the existing `/tmp` text file in Kanna's file preview and verified its content. The temporary capture is in the gitignored `docs/task-specs/cb5eb2c6-screenshots/desktop-mentioned-files-mixed.png` and intentionally will not survive worktree removal.
