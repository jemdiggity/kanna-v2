# Skip Automatic Setup for Configured Repositories

## Problem

Importing or cloning a repository currently creates a “Set Up Repository” task unconditionally. This is redundant and potentially destructive when the repository already has a root `.kanna` directory containing its Kanna configuration.

## Desired Behavior

The root `.kanna` path is the configuration boundary. After a local repository is imported or a remote repository is cloned:

- If `<repo>/.kanna` exists, finish adding the repository without creating a setup task.
- If `<repo>/.kanna` does not exist, preserve the current behavior and create the setup task.
- Treat any existing `.kanna` path as configured, regardless of its contents.
- Continue creating a setup task for a repository created through Kanna’s “Create New” flow.

## Design

Keep the decision in `useAppTaskCreation`, where repository addition is coordinated with setup-task creation. Add a small conditional setup launcher that checks `<repoPath>/.kanna` through the existing `fileExistsSafe` helper before delegating to the existing setup-task launcher.

The local import and clone handlers will use the conditional launcher after their store operation succeeds. The create handler will continue calling the unconditional launcher because a newly initialized repository is expected to need configuration.

This keeps filesystem inspection out of `AddRepoModal`, avoids stale state between inspection and import, and handles cloned repositories only after their files exist. It also avoids expanding the store and server import contracts with UI workflow policy.

If the existence check itself fails, `fileExistsSafe` reports the path as absent and the existing setup flow continues. This preserves the current recoverable behavior rather than leaving an unconfigured repository without guidance.

## Testing

Focused composable tests will verify:

- Importing a repository with `.kanna` does not load the setup agent or create a setup task.
- Importing a repository without `.kanna` still creates the setup task.
- Cloning a repository with `.kanna` does not create a setup task.
- Creating a new repository still creates the setup task.

The existing App integration test that currently expects unconditional import setup will be updated to encode the missing-`.kanna` case explicitly. The focused desktop test suite and TypeScript checks will provide broader regression coverage.
