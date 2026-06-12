import { getSetting, getUnblockedItems, listRepos, type DbHandle, type PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { listen } from "../listen";
import { clearCachedTerminalState } from "../composables/terminalStateCache";
import { markDaemonReadyObserved } from "../composables/daemonReadyState";
import {
  getTaskIdFromTeardownSessionId,
  isTeardownSessionId,
  reportCloseSessionError,
  reportPrewarmSessionError,
  shouldAutoCloseTaskAfterTeardownExit,
  shouldClearCachedTerminalStateOnSessionExit,
} from "./kannaCleanup";
import { formatAppWindowTitle, type AppBuildInfo } from "./windowTitle";
import { isTaskTearingDown } from "./taskStages";
import { requireService, type StoreContext } from "./state";
import { normalizeAppThemePreference, normalizeCodeThemePreference } from "../theme/theme";
import type { AgentMessageStyle } from "./state";

export interface InitApi {
  init: (db: DbHandle) => Promise<void>;
  loadPreferences: () => Promise<void>;
  savePreference: (key: string, value: string) => Promise<void>;
}

export function createInitApi(
  context: StoreContext,
  ports: import("./ports").PortsStore,
  tasks: Pick<import("./tasks").TasksApi, "checkUnblocked" | "handleAgentFinished" | "restoreUnblockedTask">,
): InitApi {
  function isVisibleItemInSelectedRepo(item: PipelineItem | null | undefined): item is PipelineItem {
    return Boolean(
      item
      && item.stage !== "done"
      && item.closed_at === null
      && item.repo_id === context.state.selectedRepoId.value,
    );
  }

  function resolveFocusedTaskIdBeforeExternalRefresh(): string | null {
    const selectedItem = context.state.selectedItemId.value
      ? context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value)
      : null;
    if (isVisibleItemInSelectedRepo(selectedItem)) return selectedItem.id;

    const currentItem = context.services.currentItem?.value ?? null;
    if (isVisibleItemInSelectedRepo(currentItem)) return currentItem.id;

    return null;
  }

  async function preserveFocusedTaskAfterExternalRefresh(taskId: string | null): Promise<void> {
    if (!taskId) return;

    const selectedItem = context.state.selectedItemId.value
      ? context.state.items.value.find((candidate) => candidate.id === context.state.selectedItemId.value)
      : null;
    if (isVisibleItemInSelectedRepo(selectedItem)) return;

    const focusedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!isVisibleItemInSelectedRepo(focusedItem)) return;

    context.state.selectedItemId.value = focusedItem.id;
    context.state.lastSelectedItemByRepo.value[focusedItem.repo_id] = focusedItem.id;
    await context.services.windowWorkspace?.persistSelection({
      selectedRepoId: context.state.selectedRepoId.value,
      selectedItemId: focusedItem.id,
    });
  }

  function readSessionId(event: unknown): string | null {
    const payload = (event as { payload?: { session_id?: string } }).payload ?? (event as { session_id?: string });
    return typeof payload.session_id === "string" ? payload.session_id : null;
  }

  function isTaskAgentSession(sessionId: string): boolean {
    return !sessionId.startsWith("shell-") && !isTeardownSessionId(sessionId);
  }

  function normalizeAgentMessageStyle(value: string | null): AgentMessageStyle {
    if (value === "log" || value === "terminal") return value;
    return "chat";
  }

  async function loadPreferences() {
    const suspendAfter = await getSetting(context.requireDb(), "suspendAfterMinutes");
    if (suspendAfter) context.state.suspendAfterMinutes.value = parseInt(suspendAfter, 10) || 30;
    const killAfter = await getSetting(context.requireDb(), "killAfterMinutes");
    if (killAfter) context.state.killAfterMinutes.value = parseInt(killAfter, 10) || 60;
    const ide = await getSetting(context.requireDb(), "ideCommand");
    if (ide) context.state.ideCommand.value = ide;
    const hideShortcuts = await getSetting(context.requireDb(), "hideShortcutsOnStartup");
    context.state.hideShortcutsOnStartup.value = hideShortcuts === "true";
    const linger = await getSetting(context.requireDb(), "dev.lingerTerminals");
    context.state.devLingerTerminals.value = linger === "true";
    const appTheme = await getSetting(context.requireDb(), "appTheme");
    context.state.appTheme.value = normalizeAppThemePreference(appTheme);
    const codeTheme = await getSetting(context.requireDb(), "codeTheme");
    context.state.codeTheme.value = normalizeCodeThemePreference(codeTheme);
    const agentMessageStyle = await getSetting(context.requireDb(), "agentMessageStyle");
    context.state.agentMessageStyle.value = normalizeAgentMessageStyle(agentMessageStyle);
  }

  async function savePreference(key: string, value: string) {
    const { setSetting } = await import("@kanna/db");
    await setSetting(context.requireDb(), key, value);
    await loadPreferences();
  }

  async function init(db: DbHandle) {
    context.state.db.value = db;
    await loadPreferences();

    const { clearPipelineItemActivePostAction, updatePipelineItemActivity, closePipelineItem } = await import("@kanna/db");

    const workingItems = await context.requireDb().select<PipelineItem>(
      "SELECT * FROM pipeline_item WHERE activity = 'working'",
    );
    for (const item of workingItems) {
      await updatePipelineItemActivity(context.requireDb(), item.id, "unread");
    }

    const eagerRepos = await listRepos(context.requireDb());
    const eagerItems: PipelineItem[] = [];
    const { listPipelineItems } = await import("@kanna/db");
    for (const repo of eagerRepos) {
      eagerItems.push(...await listPipelineItems(context.requireDb(), repo.id));
    }

    if (isTauri) {
      for (const item of eagerItems) {
        if (!item.branch || item.stage === "done" || item.closed_at !== null) continue;
        const repo = eagerRepos.find((candidate) => candidate.id === item.repo_id);
        if (!repo) continue;
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        const exists = await invoke<boolean>("file_exists", { path: worktreePath });
        if (!exists) {
          console.warn(`[store] closing orphaned task ${item.id}: worktree missing at ${worktreePath}`);
          await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
          item.stage = "done";
        }
      }
    }

    const unblockedItems = await getUnblockedItems(context.requireDb());
    for (const item of unblockedItems) {
      console.debug(`[store] restoring previously blocked task: ${item.id}`);
      await tasks.restoreUnblockedTask(item);
    }

    await requireService(context.services.loadInitialData, "loadInitialData")();

    const bootstrap = context.state.initialWindowBootstrap.value;
    const bootstrapRepoId = bootstrap?.selectedRepoId ?? null;
    const bootstrapItemId = bootstrap?.selectedItemId ?? null;
    if (bootstrapRepoId && eagerRepos.some((repo) => repo.id === bootstrapRepoId)) {
      context.state.selectedRepoId.value = bootstrapRepoId;
    } else if (eagerRepos.length > 0) {
      context.state.selectedRepoId.value = eagerRepos[0].id;
    }

    if (
      bootstrapItemId
      && eagerItems.some((item) =>
        item.id === bootstrapItemId
        && item.stage !== "done"
        && item.closed_at === null
        && item.repo_id === context.state.selectedRepoId.value)
    ) {
      requireService(context.services.restoreSelection, "restoreSelection")(bootstrapItemId);
    }

    if (isTauri) {
      try {
        const [branch, commitHash, worktree, gitInfo] = await Promise.all([
          invoke<string>("read_env_var", { name: "KANNA_BUILD_BRANCH" }).catch(() => ""),
          invoke<string>("read_env_var", { name: "KANNA_BUILD_COMMIT" }).catch(() => ""),
          invoke<string>("read_env_var", { name: "KANNA_BUILD_WORKTREE" }).catch(() => ""),
          invoke<{ version: string }>("git_app_info").catch(() => ({ version: "" })),
        ]);
        const title = formatAppWindowTitle({
          branch,
          commitHash,
          worktree,
          version: gitInfo.version,
        } satisfies AppBuildInfo);
        if (title) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTitle(title);
        }
      } catch (error) {
        console.error("[store] failed to set window title:", error);
      }
    }

    if (isTauri) {
      for (const item of eagerItems) {
        if (!item.branch || item.stage === "done" || item.closed_at !== null) continue;
        const repo = eagerRepos.find((candidate) => candidate.id === item.repo_id);
        if (!repo) continue;
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        requireService(context.services.prewarmWorktreeShellSession, "prewarmWorktreeShellSession")(
          `shell-wt-${item.id}`,
          worktreePath,
          item.port_env,
          repo.path,
        ).catch((error) => reportPrewarmSessionError("[store] shell pre-warm failed:", error));
      }
      for (const repo of eagerRepos) {
        requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${repo.id}`, repo.path, null, false)
          .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
      }
    }

    await context.services.windowWorkspace?.onSharedInvalidation(async () => {
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      requireService(context.services.reconcileSelection, "reconcileSelection")();
    });

    listen("session_created", async (event: unknown) => {
      const sessionId = readSessionId(event);
      if (!sessionId || !isTaskAgentSession(sessionId)) return;

      const focusedTaskId = resolveFocusedTaskIdBeforeExternalRefresh();
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await preserveFocusedTaskAfterExternalRefresh(focusedTaskId);
    });

    listen("status_changed", async (event: unknown) => {
      const payload = (event as { payload?: { session_id?: string; status?: string } }).payload ?? (event as { session_id?: string; status?: string });
      const sessionId = payload.session_id;
      const status = payload.status;
      if (!sessionId || typeof status !== "string") return;

      const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
      if (!item) return;
      await requireService(context.services.applyTaskRuntimeStatus as ((item: PipelineItem, status: string) => Promise<void>) | undefined, "applyTaskRuntimeStatus")(item, status);
    });

    listen("session_exit", async (event: unknown) => {
      const payload = (event as { payload?: { session_id?: string; code?: number; resume_session_id?: string | null } }).payload
        ?? (event as { session_id?: string; code?: number; resume_session_id?: string | null });
      const sessionId = payload.session_id;
      if (!sessionId) return;

      requireService(context.services.resolveSessionExitWaiters, "resolveSessionExitWaiters")(sessionId);
      await requireService(context.services.persistExitedSessionResumeId, "persistExitedSessionResumeId")(
        sessionId,
        payload.resume_session_id,
      );

      if (typeof sessionId === "string" && isTeardownSessionId(sessionId)) {
        const itemId = getTaskIdFromTeardownSessionId(sessionId);
        const exitCode = typeof payload.code === "number" ? payload.code : null;
        if (!itemId || !shouldAutoCloseTaskAfterTeardownExit({
          exitCode,
          lingerEnabled: context.state.devLingerTerminals.value,
        })) {
          return;
        }

        const item = context.state.items.value.find((candidate) => candidate.id === itemId);
        if (!item || !isTaskTearingDown(item)) {
          return;
        }

        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
        ]);
        if (context.state.selectedItemId.value === item.id) {
          await requireService(
            context.services.selectReplacementAfterItemRemoval,
            "selectReplacementAfterItemRemoval",
          )(item);
        }
        await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
        await tasks.checkUnblocked(item.id);
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        return;
      }

      if (shouldClearCachedTerminalStateOnSessionExit(sessionId)) {
        clearCachedTerminalState(sessionId);
      }
      void tasks.handleAgentFinished(sessionId);
    });

    listen("daemon_ready", async () => {
      markDaemonReadyObserved();
      await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
    });

    listen("pipeline_stage_complete", async (event: unknown) => {
      const payload = (event as { payload?: { task_id?: string } }).payload ?? (event as { task_id?: string });
      const taskId = payload.task_id;
      if (!taskId) return;

      const item = context.state.items.value.find((candidate) => candidate.id === taskId);
      if (!item) return;

      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();

      const freshItem = context.state.items.value.find((candidate) => candidate.id === taskId);
      if (!freshItem) return;

      const repo = context.state.repos.value.find((candidate) => candidate.id === freshItem.repo_id);
      if (!repo) return;

      try {
        const pipeline = await requireService(context.services.loadPipeline, "loadPipeline")(repo.path, freshItem.pipeline);
        const stage = pipeline.stages.find((candidate) => candidate.name === freshItem.stage);
        if (!stage) return;
        const activePostAction = freshItem.active_post_action && stage.post_action?.name === freshItem.active_post_action
          ? stage.post_action
          : null;
        const shouldAutoAdvance = activePostAction
          ? activePostAction.transition === "auto"
          : stage.transition === "auto";

        if (shouldAutoAdvance && freshItem.stage_result) {
          try {
            const claimedResult = freshItem.stage_result;
            const claimedItemSnapshot = { ...freshItem };
            const result = JSON.parse(claimedResult) as { status?: string };
            if (result.status === "success") {
              const claim = await context.requireDb().execute(
                "UPDATE pipeline_item SET stage_result = NULL, updated_at = datetime('now') WHERE id = ? AND stage_result = ?",
                [taskId, claimedResult],
              );
              if (claim.rowsAffected === 0) return;
              if (activePostAction) {
                await clearPipelineItemActivePostAction(context.requireDb(), taskId);
                await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
                const claimedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
                if (claimedItem) {
                  Object.assign(claimedItem, claimedItemSnapshot);
                  claimedItem.active_post_action = null;
                  claimedItem.stage_result = claimedResult;
                }
                await requireService(context.services.advanceStage, "advanceStage")(taskId, {
                  initiatedBy: "auto",
                  skipPostAction: true,
                });
              } else {
                await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
                const claimedItem = context.state.items.value.find((candidate) => candidate.id === taskId);
                if (claimedItem) {
                  Object.assign(claimedItem, claimedItemSnapshot);
                  claimedItem.stage_result = claimedResult;
                }
                await requireService(context.services.advanceStage, "advanceStage")(taskId, { initiatedBy: "auto" });
              }
            }
          } catch (error) {
            console.error("[store] failed to parse stage_result:", error);
          }
        }

        if (context.state.selectedItemId.value !== taskId) {
          await updatePipelineItemActivity(context.requireDb(), taskId, "unread");
          await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        }
      } catch (error) {
        console.error("[store] pipeline_stage_complete handler failed:", error);
      }
    });
  }

  return {
    init,
    loadPreferences,
    savePreference,
  };
}
