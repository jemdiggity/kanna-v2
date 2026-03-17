# Kanna

Desktop app for managing Claude Code agent tasks. Spawns Claude CLI sessions in isolated git worktrees, streams structured output, and orchestrates the PR lifecycle.

## Stack

- **Frontend:** Vue 3 (Composition API) + TypeScript
- **Desktop shell:** Tauri v2
- **Backend:** Rust (Tauri commands + daemon)
- **Terminal:** xterm.js
- **Database:** SQLite via tauri-plugin-sql
- **Git:** git2 (Rust) for local ops, git CLI for push
- **Diff rendering:** @pierre/diffs (Shiki-based)
- **Build:** pnpm workspaces + Turborepo + Vite + Cargo

## Project Structure

```
kanna-tauri/
├── apps/desktop/              # Tauri desktop app
│   ├── src/                   # Vue frontend
│   │   ├── components/        # Vue components (Sidebar, MainPanel, AgentView, etc.)
│   │   ├── composables/       # Vue composables (useTerminal, usePipeline, etc.)
│   │   ├── invoke.ts          # Tauri invoke wrapper (real + browser mock)
│   │   └── tauri-mock.ts      # Browser-mode mock layer
│   ├── src-tauri/             # Rust backend
│   │   ├── src/commands/      # Tauri invoke handlers (agent, daemon, git, fs, shell)
│   │   └── tests/             # Rust integration tests
│   └── tests/e2e/             # E2E tests (WebDriver)
├── packages/
│   ├── core/                  # Shared TypeScript business logic
│   │   └── src/               # Pipeline state machine, GitHub/Slack/Discord clients, config parser
│   └── db/                    # Database schema and queries
├── crates/
│   ├── claude-agent-sdk/      # Rust wrapper for Claude CLI (NDJSON streaming)
│   ├── daemon/                # PTY daemon (Unix socket server, session persistence)
│   └── tauri-plugin-delta-updater/  # Self-updater plugin (stub)
└── docs/superpowers/specs/    # Design specs
```

## Development

Prerequisites: Rust, Node.js, pnpm, bun

```bash
pnpm install
cd apps/desktop
bun tauri dev
```

## Testing

### Unit tests (packages/core, packages/db)
```bash
pnpm test
```

### Rust integration tests (agent SDK <-> Claude CLI)
```bash
cd apps/desktop/src-tauri
cargo test --test agent_cli_integration -- --ignored --nocapture
```

### E2E tests (WebDriver against real Tauri app)
```bash
# Terminal 1: start app with test DB
KANNA_DB_NAME=kanna-test.db bun tauri dev

# Terminal 2: run tests
cd apps/desktop
bun test:e2e          # fast mock suite
bun test:e2e:real     # live Claude CLI suite
```

## Architecture

```
Vue Frontend (components + composables)
         │
    Tauri IPC (invoke / listen)
         │
    Rust Backend (git2, daemon client, agent SDK)
         │
    ┌────┴────┐
    │         │
Claude CLI   PTY Daemon
(NDJSON)    (Unix socket)
```

The app creates tasks by:
1. Creating a git worktree for isolation
2. Spawning a Claude CLI session via the agent SDK
3. Streaming structured NDJSON messages to the AgentView
4. On completion, enabling PR creation via GitHub API

## License

Private
