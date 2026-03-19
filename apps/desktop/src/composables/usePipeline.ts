import { ref, type Ref } from "vue";
import { invoke } from "../invoke";
import type { DbHandle } from "@kanna/db";
import type { PipelineItem } from "@kanna/db";
import { listPipelineItems, updatePipelineItemStage, insertPipelineItem } from "@kanna/db";
import { canTransition, parseKannaConfig, type Stage } from "@kanna/core";

export type AgentType = "pty" | "sdk";

export function usePipeline(db: Ref<DbHandle | null>) {
  const items = ref<PipelineItem[]>([]);
  const selectedItemId = ref<string | null>(null);

  async function loadItems(repoId: string) {
    if (!db.value) return;
    items.value = await listPipelineItems(db.value, repoId);
  }

  async function transition(itemId: string, toStage: Stage) {
    if (!db.value) return;
    const item = items.value.find((i) => i.id === itemId);
    if (!item) return;
    if (!canTransition(item.stage as Stage, toStage)) return;
    await updatePipelineItemStage(db.value, itemId, toStage);
    item.stage = toStage;
  }

  async function createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType: AgentType = "pty"
  ) {
    if (!db.value) return;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // 1. Create git worktree with a unique port offset (1–100)
    // Each worktree gets port 1420 + offset for its dev server.
    const existingCount = items.value.filter((i) => i.branch).length;
    const portOffset = existingCount + 1;

    await invoke("git_worktree_add", {
      repoPath,
      branch,
      path: worktreePath,
      portOffset,
    });

    // 2. Read .kanna.toml config and run setup script if defined
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repoPath}/.kanna.toml`,
      });
      if (configContent) {
        const config = parseKannaConfig(configContent);
        if (config.tasks?.setup) {
          await invoke("run_script", {
            script: config.tasks.setup,
            cwd: worktreePath,
            env: {},
          });
        }
      }
    } catch {
      // No .kanna.toml or parse error — continue without setup
    }

    // 3. Insert pipeline item to DB
    await insertPipelineItem(db.value, {
      id,
      repo_id: repoId,
      issue_number: null,
      issue_title: null,
      prompt,
      stage: "in_progress",
      pr_number: null,
      pr_url: null,
      branch,
      agent_type: agentType,
    });

    // 4. Spawn agent based on type
    // PTY mode: don't spawn here — TerminalView will spawn on mount
    // with the correct terminal dimensions from xterm.js.
    // SDK mode: spawn immediately since no terminal sizing needed.
    if (agentType !== "pty") {
      await invoke("create_agent_session", {
        sessionId: id,
        cwd: worktreePath,
        prompt,
        systemPrompt: null,
        permissionMode: "dontAsk",
      });
    }

    // 5. Refresh pipeline items and select the new one
    await loadItems(repoId);
    selectedItemId.value = id;
  }

  /** Spawn Claude CLI in a PTY via the daemon with hook notifications.
   *  Called by TerminalView on mount so it can pass the actual terminal dimensions. */
  async function spawnPtySession(sessionId: string, cwd: string, prompt: string, cols = 80, rows = 24) {
    // Find kanna-hook binary — must be in PATH (symlink or install)
    let kannaHookPath: string;
    try {
      kannaHookPath = await invoke<string>("which_binary", { name: "kanna-hook" });
    } catch {
      throw new Error("kanna-hook not found in PATH. Run: ln -sf $(pwd)/crates/kanna-hook/target/debug/kanna-hook ~/.local/bin/kanna-hook");
    }

    // Build the --settings JSON with hooks that call kanna-hook
    const hookSettings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `${kannaHookPath} Stop ${sessionId}` }] },
        ],
        StopFailure: [
          { hooks: [{ type: "command", command: `${kannaHookPath} StopFailure ${sessionId}` }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: `${kannaHookPath} PostToolUse ${sessionId}` }] },
        ],
      },
    });

    // Build Claude CLI command
    const claudeCmd = `claude --dangerously-skip-permissions --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;

    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login", "-c", claudeCmd],
      env: { TERM: "xterm-256color" },
      cols,
      rows,
    });
  }

  function selectedItem(): PipelineItem | null {
    if (!selectedItemId.value) return null;
    return items.value.find((i) => i.id === selectedItemId.value) ?? null;
  }

  return {
    items,
    selectedItemId,
    loadItems,
    transition,
    createItem,
    spawnPtySession,
    selectedItem,
  };
}
