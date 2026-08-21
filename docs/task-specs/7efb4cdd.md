# Task 7efb4cdd: checkout a missing repository on another machine

## Goal and scope

When mobile targets a machine where the selected logical repository is not
registered, let the user explicitly confirm cloning that repository on that
machine, show clone progress, and retry the original task creation or repository
command after checkout. The desktop may reuse the API later, but desktop UI and
the separate mobile-wedge fix in task `3ccb7e4d` are out of scope.

## Design contract

- An authenticated source machine's `/v1/repos` inventory may include its
  cloneable `remoteUrl` alongside `remoteUrlHash`; the hash remains the logical
  cross-machine identity. Mobile sends the URL only to the explicitly targeted
  machine after confirmation.
- `POST /v1/repo-checkouts` starts one asynchronous server operation from
  `{name, remoteUrl, remoteUrlHash}` and returns a pollable id. The server clones
  under the existing `~/.kanna/repos/<name>[-N]` convention, registers through
  the existing `MobileApi::add_repo` path, persists remote metadata, and reports
  `running`, `done`, or `failed` through `GET /v1/repo-checkouts/{id}`.
- Clone/register is atomic from the registry's perspective. A clone failure or
  registration failure removes the operation-owned destination and leaves no
  repo row. Private repositories use credentials already available to `git` on
  the target machine; credential provisioning is deliberately out of scope and
  failures must name the target machine in mobile UI.
- Mobile's checkout action always presents a confirmation naming both repo and
  target machine. It displays the running state, then refreshes repo inventory
  and automatically retries the frozen task-create or repo-command action once.
  This is JS-only and does not change `runtimeVersion`.
- The task composer lists the currently targeted machine even when the selected
  repo is absent there. Submitting against that machine reaches the checkout
  offer, while ordinary task creation remains unavailable until checkout
  succeeds. This UI seam and its automatic retry are covered through the
  rendered composer/navigation flow.
- Fresh checkout performs exactly the current clone-and-register semantics.
  It does not launch setup commands; task/repo-command execution continues to
  apply the repository's existing `.kanna/config.json` setup semantics.

## Owner decisions still open

- Default for this task: offer checkout only for the currently targeted machine,
  not every paired machine. Expanding the offer is a product decision to flag.
- Default for this task: relay initiation remains an ordinary authenticated
  control operation and is not entitlement-gated, because git bytes travel from
  the remote directly to the target machine. Entitlement policy remains an
  owner decision to flag.

## Done when

Server happy-path and cleanup tests, a mobile confirm/progress/retry test, and a
real-server `file://` remote E2E prove task creation succeeds after checkout;
`cargo test -p kanna-server`, `pnpm test`, and `./kd test all` are run and results
reported.

## Revision history

- 2026-08-21 reviewer feedback (revision 1): expose machines absent from
  `registeredDesktopIds` in the composer so selecting and submitting reaches
  the existing named confirmation/progress/automatic-retry flow; replace the
  contradictory composer test and add component/navigation integration
  coverage. Full device E2E remains out of scope for this revision.
