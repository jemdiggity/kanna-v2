import {
  closePipelineItem,
  markPipelineItemTearingDown,
  removeAllBlockersForItem,
  reopenPipelineItem,
  unhideRepo as unhideRepoQuery,
  updatePipelineItemActivity,
  type PipelineItem,
  type Repo,
} from "@kanna/db";
import { invoke } from "../invoke";
import { renderBestEffortLifecycleCommand } from "../utils/lifecycleCommands";
import { shellSingleQuote } from "../utils/shell";
import { hasOpenSubtasks } from "../utils/taskParenting";
import { getTaskCloseBehavior } from "./taskCloseBehavior";
import { shouldSelectNextOnCloseTransition } from "./taskCloseSelection";
import { applyWorktreeProcessIsolation, buildTaskLifecycleEnv, collectTeardownCommands, hasLiveTaskResources, parseTaskPortEnv } from "./taskLifecycleEnv";
import { reportCloseSessionError } from "./kannaCleanup";
import { isTaskTearingDown } from "./taskStages";
import { resolveTaskItemForDaemonSession } from "./taskSessionIdentity";
import { isTaskSelectedInAnyWindow } from "./windowSelection";
import { readRepoConfig, requireService, type StoreContext } from "./state";
import { resolveAgentProvider } from "./agent-provider";
import { normalizeAgentExecutionType } from "./agentExecutionType";
import { publishTaskSnapshotBestEffort } from "./taskPublishing";
import type { PortsStore } from "./ports";
import type { TasksApi } from "./tasks";

export function createTaskCloseActions(
  context: StoreContext,
  ports: PortsStore,
  dependencies: { checkUnblocked: (blockerItemId: string) => Promise<void> },
): Pick<TasksApi, "closeTask" | "undoClose" | "handleAgentFinished"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function selectReplacementAfterTaskRemoval(item: PipelineItem): Promise<void> {
    if (context.state.selectedItemId.value !== item.id) return;
    await requireService(
      context.services.selectReplacementAfterItemRemoval,
      "selectReplacementAfterItemRemoval",
    )(item);
  }

  async function detachSessionsBeforeIntentionalKill(sessionIds: readonly string[]): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    await Promise.all(
      uniqueSessionIds.map((sessionId) =>
        invoke("detach_session", { sessionId }).catch((error: unknown) =>
          reportCloseSessionError(`[store] detach session before kill failed (${sessionId}):`, error),
        ),
      ),
    );
  }

  async function closePipelineItemReleasePortsAndPublish(item: PipelineItem, repo: Repo): Promise<void> {
    await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
    await publishTaskSnapshotBestEffort(context, item.id, repo);
  }

  function taskIdCandidatesFromWorktreeName(name: string): string[] {
    if (!name.startsWith("task-")) return [];
    const remainder = name.slice("task-".length);
    if (!remainder) return [];
    const candidates = [remainder];
    const lastDash = remainder.lastIndexOf("-");
    if (lastDash > 0) {
      const suffix = remainder.slice(lastDash + 1);
      if (/^\d+$/.test(suffix)) {
        candidates.push(remainder.slice(0, lastDash));
      }
    }
    return candidates;
  }

  async function resolveTaskIdFromWorktreeName(name: string): Promise<string | null> {
    for (const candidate of taskIdCandidatesFromWorktreeName(name)) {
      const rows = await context.requireDb().select<{ id: string }>(
        "SELECT id FROM pipeline_item WHERE id = ? LIMIT 1",
        [candidate],
      );
      if (rows.length > 0) return candidate;
    }
    return null;
  }

  async function collectTaskWorktreeCleanupPaths(item: PipelineItem, repo: Repo): Promise<string[]> {
    const paths = new Set<string>();
    const rows = await context.requireDb().select<{ path: string }>(
      "SELECT path FROM worktree WHERE pipeline_item_id = ?",
      [item.id],
    );
    rows.forEach((row) => {
      if (row.path) paths.add(row.path);
    });

    const worktreesDir = `${repo.path}/.kanna-worktrees`;
    const names = await invoke<string[]>("list_dir", { path: worktreesDir }).catch(() => []);
    for (const name of names) {
      if (await resolveTaskIdFromWorktreeName(name) === item.id) {
        paths.add(`${worktreesDir}/${name}`);
      }
    }

    return [...paths].sort();
  }

  async function cleanupClosedTaskWorktrees(item: PipelineItem, repo: Repo): Promise<void> {
    const paths = await collectTaskWorktreeCleanupPaths(item, repo);
    if (paths.length > 0) {
      const quotedPaths = paths.map((path) => shellSingleQuote(path)).join(" ");
      const script = [
        "set -e",
        `repo=${shellSingleQuote(repo.path)}`,
        `for wt in ${quotedPaths}; do`,
        "  if [ -d \"$wt\" ]; then",
        "    if [ -n \"$(git -C \"$wt\" status --porcelain)\" ]; then",
        `      git -C "$wt" add -A && git -C "$wt" commit -m ${shellSingleQuote("WIP at task close")}`,
        "    fi",
        "  fi",
        "  git -C \"$repo\" worktree remove --force --force \"$wt\" || { [ ! -e \"$wt\" ] || rm -rf \"$wt\"; }",
        "done",
        "git -C \"$repo\" worktree prune",
      ].join("\n");
      await invoke("run_script", { script, cwd: repo.path, env: {} });
    } else {
      await invoke("run_script", {
        script: "git worktree prune",
        cwd: repo.path,
        env: {},
      }).catch((error: unknown) => {
        console.debug("[store] git worktree prune skipped during close cleanup:", error);
      });
    }
    await context.requireDb().execute("DELETE FROM worktree WHERE pipeline_item_id = ?", [item.id]);
  }

  async function closePipelineItemReleasePortsPublishAndCleanup(item: PipelineItem, repo: Repo): Promise<void> {
    await closePipelineItemReleasePortsAndPublish(item, repo);
    await cleanupClosedTaskWorktrees(item, repo);
  }

  async function closeTask(targetItemId?: string, opts?: { selectNext?: boolean }) {
    const item = targetItemId
      ? context.state.items.value.find((candidate) => candidate.id === targetItemId)
      : requireService(context.services.currentItem, "currentItem").value;
    const repo = item
      ? context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      : requireService(context.services.selectedRepo, "selectedRepo").value;
    if (!item || !repo) return;
    if (hasOpenSubtasks(context.state.items.value, item.id)) {
      context.toast.warning(context.tt("toasts.closeTaskHasOpenSubtasks"));
      return;
    }

    try {
      const wasBlocked = context.state.taskBlockers.value.some((blocker) => blocker.blocked_item_id === item.id);
      const ownsLiveTaskResources = hasLiveTaskResources(item);
      const existingTeardown = isTaskTearingDown(item);
      const teardownCmds = existingTeardown || !ownsLiveTaskResources
        ? []
        : await collectTeardownCommands(item, repo);
      const closeBehavior = getTaskCloseBehavior({
        wasBlocked,
        hasLiveTaskResources: ownsLiveTaskResources,
        currentStage: item.stage,
        isTearingDown: existingTeardown,
        hasTeardownCommands: teardownCmds.length > 0,
      });

      if (closeBehavior === "finish" && existingTeardown) {
        await detachSessionsBeforeIntentionalKill([item.id, `shell-wt-${item.id}`, `td-${item.id}`]);
        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
          invoke("kill_session", { sessionId: `td-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill teardown session failed:", error)),
        ]);
        if (wasBlocked) {
          await removeAllBlockersForItem(context.requireDb(), item.id);
        }
        await closePipelineItemReleasePortsPublishAndCleanup(item, repo);

        if (opts?.selectNext !== false) await selectReplacementAfterTaskRemoval(item);
        await dependencies.checkUnblocked(item.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        return;
      }

      if (closeBehavior === "finish" && wasBlocked && !ownsLiveTaskResources) {
        await removeAllBlockersForItem(context.requireDb(), item.id);
        await closePipelineItemReleasePortsPublishAndCleanup(item, repo);

        if (opts?.selectNext !== false) await selectReplacementAfterTaskRemoval(item);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        void detachSessionsBeforeIntentionalKill([item.id]).then(() =>
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill_session failed:", error)),
        );
        return;
      }

      if (closeBehavior === "finish") {
        await detachSessionsBeforeIntentionalKill([item.id, `shell-wt-${item.id}`]);
        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
        ]);
        if (wasBlocked) {
          await removeAllBlockersForItem(context.requireDb(), item.id);
        }
        if (shouldSelectNextOnCloseTransition({
          selectNext: opts?.selectNext !== false,
          wasBlocked,
          previousStage: item.stage,
          nextStage: "closed",
        })) {
          await selectReplacementAfterTaskRemoval(item);
        }
        await closePipelineItemReleasePortsPublishAndCleanup(item, repo);
        await dependencies.checkUnblocked(item.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        return;
      }

      if (normalizeAgentExecutionType(item.agent_type) === "agent") {
        await invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
          reportCloseSessionError("[store] kill SDK agent session failed:", error));
      } else {
        await invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((error: unknown) =>
          reportCloseSessionError("[store] signal_session failed:", error));
      }

      const enterTeardownState = async (): Promise<void> => {
        await markPipelineItemTearingDown(context.requireDb(), item.id);
        if (shouldSelectNextOnCloseTransition({
          selectNext: opts?.selectNext !== false,
          wasBlocked,
          previousStage: item.stage,
          nextStage: "tearing_down",
        })) {
          await selectReplacementAfterTaskRemoval(item);
        }
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
      };

      let teardownExit: Promise<void> | null = null;
      if (teardownCmds.length > 0) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        const repoConfig = await readRepoConfig(worktreePath);
        const { env: teardownEnv } = await buildTaskLifecycleEnv({
          taskId: item.id,
          worktreePath,
          repoConfig,
          portEnv: parseTaskPortEnv(item.port_env),
          logContext: "teardown",
        });
        const scriptParts = teardownCmds.map((command) => renderBestEffortLifecycleCommand(command, "Teardown"));
        const fullCmd = `printf '\\033[33mRunning teardown...\\033[0m\\n' && ${scriptParts.join(" && ")} && printf '\\n'`;
        const tdSessionId = `td-${item.id}`;
        await enterTeardownState();
        teardownExit = requireService(context.services.waitForSessionExit, "waitForSessionExit")(tdSessionId);
        await invoke("spawn_session", {
          sessionId: tdSessionId,
          cwd: worktreePath,
          executable: "/bin/zsh",
          args: ["--login", "-i", "-c", fullCmd],
          env: applyWorktreeProcessIsolation(teardownEnv),
          cols: 120,
          rows: 30,
        });
        await invoke("attach_session_with_snapshot", { sessionId: tdSessionId });
      }

      void teardownExit;
    } catch (error) {
      console.error("[store] close failed:", error);
      context.toast.error(context.tt("toasts.closeTaskFailed"));
    }
  }

  async function undoClose() {
    if (context.state.lastHiddenRepoId.value) {
      const repoId = context.state.lastHiddenRepoId.value;
      context.state.lastHiddenRepoId.value = null;
      await unhideRepoQuery(context.requireDb(), repoId);
      await reloadSnapshot();
      await invalidateWindowWorkspace("undoClose");
      return;
    }

    try {
      const rows = await context.requireDb().select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1",
      );
      const item = rows[0];
      if (!item) return;
      const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
      if (!repo) return;
      const worktreePath = item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;

      await reopenPipelineItem(context.requireDb(), item.id);
      if (item.branch) {
        const worktreeExists = await invoke<boolean>("file_exists", { path: worktreePath }).catch(() => false);
        if (!worktreeExists) {
          await invoke("git_worktree_add", {
            repoPath: repo.path,
            branch: item.branch,
            path: worktreePath,
            startPoint: null,
          });
          await context.requireDb().execute(
            "INSERT INTO worktree (id, pipeline_item_id, path, branch) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pipeline_item_id = excluded.pipeline_item_id, path = excluded.path, branch = excluded.branch",
            [`wt-${item.id}`, item.id, worktreePath, item.branch],
          );
        }
      }
      let portEnv: Record<string, string> = {};
      let portOffset: number | null = null;
      let portAllocationFailed = false;
      try {
        const repoConfig = await readRepoConfig(worktreePath);
        const allocated = await ports.claimTaskPorts(item.id, repoConfig);
        portEnv = allocated.portEnv;
        portOffset = allocated.firstPort;
        await context.requireDb().execute(
          "UPDATE pipeline_item SET port_offset = ?, port_env = ?, updated_at = datetime('now') WHERE id = ?",
          [portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, item.id],
        );
      } catch (error) {
        await ports.releaseTaskPorts(item.id).catch((cleanupError) => {
          console.debug("[store] failed to release ports after undo close allocation failure:", cleanupError);
        });
        portAllocationFailed = true;
        console.error("[store] undo close port allocation failed:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }

      await requireService(context.services.selectItem, "selectItem")(item.id);
      await reloadSnapshot();
      await invalidateWindowWorkspace("undoClose");

      if (item.branch && !portAllocationFailed) {
        try {
          const agentProvider = resolveAgentProvider(
            item.agent_provider,
            await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
          );
          await requireService(context.services.spawnPtySession, "spawnPtySession")(item.id, worktreePath, item.prompt || "", 80, 24, {
            agentProvider,
            ...(item.agent_session_id ? { resumeSessionId: item.agent_session_id } : {}),
          });
          await updatePipelineItemActivity(context.requireDb(), item.id, "working");
          await reloadSnapshot();
        } catch (spawnError) {
          await updatePipelineItemActivity(context.requireDb(), item.id, "idle");
          await reloadSnapshot();
          console.error("[store] session re-spawn after undo failed:", spawnError);
          context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${spawnError instanceof Error ? spawnError.message : spawnError}`);
        }
      }

      context.state.selectedItemId.value = item.id;
    } catch (error) {
      console.error("[store] undo close failed:", error);
      context.toast.error(context.tt("toasts.undoCloseFailed"));
    }
  }

  async function handleAgentFinished(sessionId: string) {
    const item = resolveTaskItemForDaemonSession(context.state.items.value, sessionId);
    if (!item) return;
    if (item.closed_at !== null) return;
    const activity = await isTaskSelectedInAnyWindow(context, item.id) ? "idle" : "unread";
    try {
      await updatePipelineItemActivity(context.requireDb(), item.id, activity);
      await reloadSnapshot();
      await invalidateWindowWorkspace("taskActivity");
    } catch (error) {
      console.error("[store] activity update failed:", error);
    }
  }


  return {
    closeTask,
    undoClose,
    handleAgentFinished,
  };
}
