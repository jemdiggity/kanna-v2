# Kanna

Keyboard-centric macOS app for running Claude CLI in worktrees.
Upgrade from tmux.

## Features

- Run multiple agent tasks in parallel, each in an isolated git worktree
- Real-time terminal with full Claude TUI
- Built-in diff viewer (branch, last commit, or working changes)
- One-click PR creation and merge
- PTY daemon survives app restarts
- Multi-repo support

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jemdiggity/kanna/main/scripts/install.sh | sh
```

Requires [Claude CLI](https://docs.anthropic.com/en/docs/claude-code).

## License

[MIT](LICENSE)
