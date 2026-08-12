# Updater key-file release E2E gap (2026-08-12)

`kd release ship` now loads updater selectors from the owner-only machine-global
release environment, securely opens the selected private-key file, and proves
that key matches the configured updater public key before release mutation.

A full release E2E is not safe or practical in the normal test suite because it
would require both macOS architecture builds, Developer ID signing and Apple
notarization credentials, and a GitHub publication target. Exercising those
services would also risk publishing a release, which this change does not
authorize.

Focused tests cover the production boundaries without real publication:

- release task tests prove `~/.kanna/.env.release.local` is loaded before ship
  and promotion receive their environment;
- real filesystem tests cover absolute paths, missing files, directories,
  symlinks, current-user ownership, modes `0400`/`0600`, unsafe or unreadable
  modes, and empty files;
- release integration tests prove unsafe files fail before version mutation,
  Bazel, bundling, or publication in dry-run, staging, production, and promotion;
- a real Ed25519/minisign compatibility check proves a wrong public key fails
  and that private material reaches only the signer child environment.

A safe full E2E would require a hermetic release backend with disposable signing
identities, small dual-architecture fixtures, a local notarization substitute,
and a non-GitHub publication sink.
