# Visible Task Setup Output Design

## Summary

New PTY tasks will run repository setup commands in the same daemon-backed terminal that subsequently launches the agent. The selected task terminal will show the setup command banner, each command, live stdout and stderr, and then the agent startup in one continuous scrollback.

This restores the observable setup behavior that was lost when new-task setup moved into the server's synchronous preparation path. Headless agent sessions retain their current pre-spawn setup because they do not have an interactive terminal surface.

## Context

The desktop creates an optimistic task slot immediately, but the server currently completes all workspace setup before it spawns the daemon session and returns the durable task. `run_workspace_setup_commands` executes each command with `std::process::Command::output`, capturing output that is only used to construct an error. During a successful install the UI can therefore show "Setting up task" for several seconds without explaining what is running, and no terminal exists yet for the user to inspect.

The task creator already has a PTY bootstrap path for stage sessions. `build_task_shell_command` composes setup commands and the provider command into one login-shell command, prints a startup banner and each setup command, runs them sequentially, refreshes the shell command cache, and starts the agent. Reusing that path for initial PTY creation provides real terminal output without introducing a second progress transport.

## Goals

- Show new-task repository setup commands and their live output in the agent terminal.
- Spawn the daemon session early enough that setup does not hold the task-create request open.
- Preserve setup shell state, including exported variables and `PATH` changes, for the agent command.
- Preserve output emitted before the desktop attaches through the daemon's terminal snapshot.
- Keep setup failures visible and prevent the agent from starting after a failed command.
- Avoid changing headless agent-session presentation or protocol behavior.

## Non-goals

- Fixing terminal input or keyboard-echo latency; that work is tracked separately.
- Adding a new setup-progress event or terminal protocol.
- Making setup commands interactive or adding a setup-specific input mode.
- Showing a terminal for SDK/headless agent sessions.
- Changing repository setup configuration or command ordering.

## PTY Creation Flow

For `AgentSessionType::Pty`, new-task preparation will read setup commands and runtime environment as it does today, but it will not execute setup on the server. It will choose the configured provider by precedence, prepare the provider command by executable name, and pass the setup command list into `build_prepared_session`.

`build_prepared_session` will use the existing PTY shell bootstrap:

1. Spawn the daemon session in the new worktree.
2. Start a login shell that prints `Running startup...`.
3. Print each command as `$ <command>` and execute the commands sequentially.
4. Run `rehash` after successful setup so newly installed executables are discoverable.
5. Launch the selected provider in the same shell.

The task-create API returns after the daemon acknowledges the session spawn, rather than after setup completes. The desktop can hydrate the optimistic slot and attach while setup is running. If output wins that race, the daemon's headless terminal snapshot includes it when the desktop attaches.

The terminal is an ordinary PTY throughout this sequence. Kanna does not add an interactive setup contract; repository setup commands are expected to remain unattended bootstrap commands.

## Provider Resolution

Initial PTY creation with setup commands will bind the first configured provider candidate before setup executes. The provider executable remains a shell-resolved name until the bootstrap reaches the agent command, so setup can install it or add it to `PATH`.

Kanna will not execute setup and then silently switch to a lower-priority provider candidate. If the selected provider remains unavailable after setup, the shell reports the launch failure in the terminal and exits nonzero. This makes configured precedence deterministic and keeps the setup and agent in one continuous PTY. PTY tasks with no setup commands retain the existing ordered availability fallback because there is no deferred bootstrap that could change provider availability.

Headless sessions continue to execute setup before resolving an absolute provider executable. Their current post-setup fallback behavior remains unchanged because they have no terminal in which to defer setup.

## Failure Behavior

Setup commands retain fail-fast `&&` semantics. A nonzero setup exit prevents `rehash` and the provider command from running. Its output and exit message remain in terminal scrollback, and the daemon reports the session exit through the existing terminal lifecycle.

Failures that occur before a daemon session can be spawned, such as worktree creation or invalid task configuration, continue to fail the create request through the existing task-preparation error path.

## Testing

Focused tests will cover:

- new PTY task preparation defers repository setup into the prepared session instead of invoking the server-side setup runner;
- the generated PTY bootstrap orders the setup banner, commands, setup output, and provider output;
- a provider executable created by setup is found after `rehash` and starts successfully;
- a failing setup command prevents provider launch while leaving its output observable;
- provider candidate precedence is fixed before PTY setup;
- headless task creation still completes setup before provider executable resolution; and
- existing stage-session setup behavior remains unchanged.

Verification will run the focused `kanna-server` task-creator tests, the full `kanna-server` test target, and the repository's canonical checks where practical.
