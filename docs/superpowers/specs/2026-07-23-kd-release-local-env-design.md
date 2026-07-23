# Kd Release Local Environment Design

## Goal

Let Kanna release commands reuse repository-specific, non-secret local
configuration across every worktree without requiring shipping agents to know
which shell exported it.

The first stored setting is the macOS notarization Keychain profile:

```dotenv
APPLE_KEYCHAIN_PROFILE=kanna-notarization
```

Apple IDs and app-specific passwords should remain in macOS Keychain, not in
the dotenv file.

## File location

The configuration lives at `.env.release.local` in the primary repository
checkout and is ignored by Git.

Kanna release work runs in linked Git worktrees. Reading the active worktree's
root would therefore miss a file created in the primary checkout. Kd must use
Git metadata to resolve the primary checkout and read the file there, so one
repository has one release environment shared by all of its worktrees.

The file is local machine state. Kd does not create it automatically. For the
current Kanna repository it will be created explicitly with mode `0600`.

## Loading and precedence

A focused release-environment helper will:

1. Resolve the primary checkout for the current repository.
2. Look for `.env.release.local` at that root.
3. Return the inherited environment unchanged when the file is absent.
4. Parse the file using Node's standard dotenv parser.
5. Merge file values underneath the inherited environment.

Explicitly exported variables therefore take precedence:

```text
effective environment = dotenv values + inherited shell overrides
```

The helper returns a new environment object and does not mutate
`process.env`.

Only `release ship` and `release promote` use the merged environment. Release
status and branch cutting do not need signing credentials, and unrelated kd
commands must not be affected by release-local configuration.

## Errors and security

An absent file is a normal no-op.

An existing file that cannot be read or parsed is a hard failure with an error
that names the file. A malformed local configuration must not be silently
ignored immediately before a signing or publishing operation.

The repository ignores `.env.release.local` to prevent accidental commits.
Documentation recommends storing Apple notarization credentials in a
`notarytool` Keychain profile and storing only `APPLE_KEYCHAIN_PROFILE` in the
file. Kd still treats all loaded values as sensitive: it passes them to child
processes but does not print them.

## Components

### Release environment helper

A small module under `tools/kd/src/runtime/` owns primary-checkout resolution,
dotenv parsing, precedence, and errors. Keeping this separate from release
business logic makes the behavior independently testable and prevents generic
kd context resolution from gaining command-specific policy.

### Release task registry

The `release.ship` and `release.promote` task definitions call the helper after
resolving the normal kd context, then pass the merged environment to
`shipRelease`. No other release behavior changes.

### Documentation and local configuration

- `.gitignore` lists `.env.release.local`.
- `docs/dev/release.md` documents the lookup location, precedence, and Keychain
  recommendation.
- The primary Kanna checkout gets a local mode-`0600` file containing the
  `kanna-notarization` profile name.

## Testing

Unit tests cover:

- a linked worktree resolving the primary checkout's file;
- a normal checkout resolving its own root;
- an absent file leaving the environment unchanged;
- valid dotenv syntax;
- inherited environment values overriding file values;
- malformed and unreadable files producing path-specific failures.

Registry-level tests prove that ship and promote receive the merged release
environment while unrelated commands remain unchanged.

The implementation is verified with the focused kd tests, kd typecheck, and
the repository's canonical test command if focused verification passes.
