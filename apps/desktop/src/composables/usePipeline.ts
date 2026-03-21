import { ref, type Ref } from "vue";
import { invoke } from "../invoke";
import type { DbHandle } from "@kanna/db";
import type { PipelineItem } from "@kanna/db";
import { listPipelineItems, updatePipelineItemStage, insertPipelineItem, getRepo, pinPipelineItem, unpinPipelineItem, reorderPinnedItems, updatePipelineItemDisplayName } from "@kanna/db";
import { canTransition, parseRepoConfig, type RepoConfig, type Stage } from "@kanna/core";

export type AgentType = "pty" | "sdk";

export function usePipeline(db: Ref<DbHandle | null>) {
  const allItems = ref<PipelineItem[]>([]);
  const selectedItemId = ref<string | null>(null);

  /** Load items for all repos into the single allItems list. */
  async function loadAllItems(repoIds: string[]) {
    if (!db.value) return;
    const loaded: PipelineItem[] = [];
    for (const repoId of repoIds) {
      const repoItems = await listPipelineItems(db.value, repoId);
      loaded.push(...repoItems);
    }
    allItems.value = loaded;
  }

  async function transition(itemId: string, toStage: Stage) {
    if (!db.value) return;
    const item = allItems.value.find((i) => i.id === itemId);
    if (!item) return;
    if (!canTransition(item.stage as Stage, toStage)) return;
    await updatePipelineItemStage(db.value, itemId, toStage);
    item.stage = toStage;
  }

  async function createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType: AgentType = "pty",
    opts?: { baseBranch?: string; stage?: Stage },
  ) {
    if (!db.value) return;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // 1. Read .kanna/config.json
    let repoConfig: RepoConfig = {};
    try {
      const configContent = await invoke<string>("read_text_file", {
        path: `${repoPath}/.kanna/config.json`,
      });
      if (configContent) repoConfig = parseRepoConfig(configContent);
    } catch {
      // No .kanna/config.json or parse error — continue without config
    }

    // 2. Assign port offset (lowest unused across all items)
    const usedOffsets = new Set(
      allItems.value.map((i) => i.port_offset).filter((o): o is number => o != null)
    );
    let portOffset = 1;
    while (usedOffsets.has(portOffset)) portOffset++;

    // 3. Create git worktree (optionally branched from a specific start point)
    const worktreeAddCwd = opts?.baseBranch
      ? `${repoPath}/.kanna-worktrees/${opts.baseBranch}`
      : repoPath;
    try {
      await invoke("git_worktree_add", {
        repoPath: worktreeAddCwd,
        branch,
        path: worktreePath,
        startPoint: opts?.baseBranch ? "HEAD" : null,
      });
    } catch (e) {
      console.error("[createItem] git_worktree_add failed:", e);
      throw e;
    }

    // 4. Compute port env vars from config + offset
    const portEnv: Record<string, string> = {};
    if (repoConfig.ports) {
      for (const [name, base] of Object.entries(repoConfig.ports)) {
        portEnv[name] = String(base + portOffset);
      }
    }

    // 5. Insert pipeline item to DB (setup runs in PTY before agent starts)
    try {
      await insertPipelineItem(db.value, {
        id,
        repo_id: repoId,
        issue_number: null,
        issue_title: null,
        prompt,
        stage: opts?.stage || "in_progress",
        pr_number: null,
        pr_url: null,
        branch,
        agent_type: agentType,
        port_offset: portOffset,
        port_env: Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null,
        activity: "working",
      });
    } catch (e) {
      console.error("[createItem] DB insert failed:", e);
      throw e;
    }

    // 6. Spawn agent
    // Refresh items first — spawnPtySession reads port_env from items list
    await loadAllItems([repoId]);

    if (agentType !== "pty") {
      await invoke("create_agent_session", {
        sessionId: id,
        cwd: worktreePath,
        prompt,
        systemPrompt: null,
        permissionMode: "dontAsk",
      });
    } else {
      // Pre-spawn PTY so connection is instant when the terminal mounts.
      // Default 80x24 — TerminalView will resize to actual dimensions on attach.
      try {
        await spawnPtySession(id, worktreePath, prompt);
      } catch (e) {
        console.warn("[pipeline] PTY pre-spawn failed, will retry on mount:", e);
      }
    }

    // 7. Select the new item
    selectedItemId.value = id;
  }

  /** Spawn Claude CLI in a PTY via the daemon with hook notifications.
   *  Called by TerminalView on mount so it can pass the actual terminal dimensions. */
  async function spawnPtySession(sessionId: string, cwd: string, prompt: string, cols = 80, rows = 24, model?: string) {
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
        SessionStart: [
          { hooks: [{ type: "command", command: `${kannaHookPath} SessionStart ${sessionId}` }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `${kannaHookPath} UserPromptSubmit ${sessionId}` }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: `${kannaHookPath} Stop ${sessionId}` }] },
        ],
        StopFailure: [
          { hooks: [{ type: "command", command: `${kannaHookPath} StopFailure ${sessionId}` }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: `${kannaHookPath} PostToolUse ${sessionId}` }] },
        ],
        PreToolUse: [
          { matcher: "AskUserQuestion", hooks: [{ type: "command", command: `${kannaHookPath} WaitingForInput ${sessionId}` }] },
        ],
        Notification: [
          { hooks: [{ type: "command", command: `${kannaHookPath} WaitingForInput ${sessionId}` }] },
        ],
      },
    });

    // Build env from item's stored port_env + setup from config
    const env: Record<string, string> = { TERM: "xterm-256color", TERM_PROGRAM: "vscode" };
    let setupCmds: string[] = [];
    const item = allItems.value.find((i) => i.id === sessionId);
    if (item) {
      // Port env vars (computed at task creation, stored in DB)
      if (item.port_env) {
        try {
          Object.assign(env, JSON.parse(item.port_env));
        } catch (e) { console.error("[spawnPty] failed to parse port_env:", e); }
      }
      // Setup scripts (read from config — only needed at spawn time)
      try {
        const repo = await getRepo(db.value!, item.repo_id);
        if (repo) {
          const configContent = await invoke<string>("read_text_file", {
            path: `${repo.path}/.kanna/config.json`,
          });
          if (configContent) {
            const repoConfig = parseRepoConfig(configContent);
            if (repoConfig.setup?.length) setupCmds = repoConfig.setup;
          }
        }
      } catch (e) { console.error("[spawnPty] failed to read setup config:", e); }
    }

    // Let the worktree know it's a worktree — daemon auto-uses {cwd}/.kanna-daemon
    env.KANNA_WORKTREE = "1";

    // Build shell command: setup scripts first, then Claude CLI
    const modelFlag = model ? ` --model ${model}` : "";
    const claudeCmd = `claude --dangerously-skip-permissions${modelFlag} --settings '${hookSettings}' '${prompt.replace(/'/g, "'\\''")}'`;
    const fullCmd = [...setupCmds, claudeCmd].join(" && ");

    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login", "-c", fullCmd],
      env,
      cols,
      rows,
    });
  }

  async function startPrAgent(itemId: string, repoId: string, repoPath: string) {
    if (!db.value) return;
    const item = allItems.value.find((i) => i.id === itemId);
    if (!item?.branch) return;

    const sourceWorktree = `${repoPath}/.kanna-worktrees/${item.branch}`;
    const prompt = [
      `You are in a worktree branched from "${item.branch}".`,
      `Your job is to create a GitHub pull request for that work.`,
      `IMPORTANT: First, check for uncommitted changes in the source worktree at "${sourceWorktree}" by running "git -C ${sourceWorktree} status".`,
      `If there are uncommitted changes there, commit them from that worktree: "git -C ${sourceWorktree} add -A && git -C ${sourceWorktree} commit -m '<appropriate message>'", then pull those commits into your branch: "git pull --rebase".`,
      `Then:`,
      `1. Rename this branch to something meaningful based on the commits (use "git branch -m <new-name>").`,
      `2. Push the branch (git push -u origin HEAD).`,
      `3. Create a PR with "gh pr create" — write a clear title and description summarizing the changes.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { baseBranch: item.branch, stage: "pr" });
  }

  async function startMergeAgent(repoId: string, repoPath: string) {
    if (!db.value) return;

    const prompt = [
      `You are a merge agent. Your job is to safely merge pull requests without breaking the target branch.`,
      ``,
      `## Process`,
      ``,
      `1. Ask the user which PR(s) to merge and the target branch (default: main).`,
      ``,
      `2. Your worktree is your staging area. Fetch and reset it to the latest origin target branch.`,
      ``,
      `3. Determine what checks to run:`,
      `   a. Check .kanna/config.json for a configured test script (the "test" field, an array of shell commands).`,
      `   b. If none, discover what checks the repo has (CI config, test scripts, Makefile, etc.).`,
      `   c. If you can't determine what to run, ask the user.`,
      ``,
      `4. For each PR, sequentially:`,
      `   a. Rebase the PR branch onto your worktree's HEAD.`,
      `   b. If there are conflicts, attempt to resolve them. Show the user your resolutions and get approval before continuing.`,
      `   c. Run the checks determined in step 3.`,
      `   d. If checks fail, attempt to fix the issue. Show the user your fix and get approval before continuing.`,
      `   e. If checks pass, merge the PR to the target branch on origin.`,
      `   f. Update your worktree HEAD to match the new origin target branch.`,
      `   g. Delete the merged remote branch.`,
      ``,
      `5. Report results — which PRs merged, which failed, and why.`,
      ``,
      `## Principles`,
      ``,
      `- Each PR is merged individually. Don't hold passing PRs hostage to failing ones.`,
      `- Always rebase onto the latest target branch before running checks.`,
      `- Work in your worktree. Never modify the user's local main.`,
      `- When in doubt, ask the user. Don't force-push, skip tests, or resolve ambiguous conflicts silently.`,
      `- Keep the user informed of progress but don't be verbose.`,
      `- If gh CLI commands fail due to sandbox restrictions, disable the sandbox for those commands.`,
    ].join("\n");

    await createItem(repoId, repoPath, prompt, "pty", { stage: "merge" });
  }

  async function pinItem(itemId: string, position: number) {
    if (!db.value) return;
    await pinPipelineItem(db.value, itemId, position);
    const item = allItems.value.find((i) => i.id === itemId);
    if (item) {
      item.pinned = 1;
      item.pin_order = position;
    }
  }

  async function unpinItem(itemId: string) {
    if (!db.value) return;
    await unpinPipelineItem(db.value, itemId);
    const item = allItems.value.find((i) => i.id === itemId);
    if (item) {
      item.pinned = 0;
      item.pin_order = null;
    }
  }

  async function renameItem(itemId: string, displayName: string | null) {
    if (!db.value) return;
    await updatePipelineItemDisplayName(db.value, itemId, displayName);
    const item = allItems.value.find((i) => i.id === itemId);
    if (item) item.display_name = displayName;
  }

  async function reorderPinned(repoId: string, orderedIds: string[]) {
    if (!db.value) return;
    await reorderPinnedItems(db.value, repoId, orderedIds);
    orderedIds.forEach((id, index) => {
      const item = allItems.value.find((i) => i.id === id);
      if (item) item.pin_order = index;
    });
  }

  function selectedItem(): PipelineItem | null {
    if (!selectedItemId.value) return null;
    return allItems.value.find((i) => i.id === selectedItemId.value) ?? null;
  }

  return {
    allItems,
    selectedItemId,
    loadAllItems,
    transition,
    createItem,
    spawnPtySession,
    startPrAgent,
    startMergeAgent,
    selectedItem,
    pinItem,
    unpinItem,
    reorderPinned,
    renameItem,
  };
}
