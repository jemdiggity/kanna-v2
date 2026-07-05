import { computed, ref, watch, type ComputedRef } from "vue";
import { computedAsync } from "@vueuse/core";
import type { DbHandle, PipelineItem } from "../types/kanna";

import { getConfiguredDesktopAuthSession } from "../services/desktopAuthSdk";
import { runDesktopAutoSignIn } from "../services/desktopAutoSignIn";
import type { DesktopAuthSession, DesktopAuthState } from "../services/desktopAuth";
import {
  listDesktopCloudTasks,
  subscribeDesktopCloudTasks,
  type DesktopCloudSnapshot,
} from "../services/desktopCloudTaskIndex";
import { invoke } from "../invoke";
import { listDesktopLanTasks, publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { deleteRemoteTaskSnapshots, reconcileDesktopTaskSnapshots } from "../services/desktopCloudPublisher";
import { getCachedRepoRemoteMetadata } from "../services/repoRemoteUrl";
import { createConfiguredDesktopRelayTerminalClient } from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";
import { fetchClosedTaskIdentities } from "../services/desktopServerClient";
import { computeTaskSnapshotFingerprint } from "../utils/cloudTaskFingerprint";
import { remoteTaskClosureAliases, remoteTaskIsLocallyClosed } from "../utils/remoteTaskIdentity";
import { buildWorkspace } from "../workspace/buildWorkspace";
import type { WorkspaceTask } from "../workspace/types";
import type { useKannaStore } from "../stores/kanna";
import type { useToast } from "./useToast";

export type AppSidebarItem = PipelineItem & {
  remote_task?: boolean;
};

type LocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id" | "stage" | "closed_at">;
type ClosedLocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id">;

interface UseAppCloudWorkspaceOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
}

const CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS = 30_000;

export function useAppCloudWorkspace({ db, store, toast }: UseAppCloudWorkspaceOptions) {
  const desktopAuthSession = ref<DesktopAuthSession | null>(null);
  const desktopAuthState = ref<DesktopAuthState>({ status: "signedOut" });
  const cloudSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
  const lanSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
  const locallyClosedRemoteTaskIds = ref<Set<string>>(new Set());
  let unsubscribeDesktopAuth: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let subscribedCloudUid: string | null = null;
  let lanRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const reconciledCloudSnapshotUsers = new Set<string>();
  let lastPublishedTaskFingerprint: string | null = null;
  let lastCloudBackendErrorToastAt: number | null = null;
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);

  const localReposForCloudMatching = computedAsync(async () => {
    return Promise.all(store.repos.map(async (repo) => {
      const metadata = await getCachedRepoRemoteMetadata(db, repo);
      return {
        repo,
        remoteUrl: metadata.remoteUrl,
        remoteUrlHash: metadata.remoteUrlHash,
      };
    }));
  }, store.repos.map((repo) => ({
    repo,
    remoteUrl: null,
    remoteUrlHash: null,
  })));

  const closedLocalTaskIdentities = computedAsync<ClosedLocalTaskIdentity[]>(async () => {
    const repos = store.repos.map((repo) => ({ id: repo.id }));
    const openTaskMarker = store.items
      .map((item) => `${item.repo_id}:${item.id}:${item.stage}:${item.closed_at ?? ""}:${item.updated_at}`)
      .join("\n");
    void openTaskMarker;

    void db;
    const repoIds = new Set(repos.map((repo) => repo.id));
    const tasks = await fetchClosedTaskIdentities().catch((error: unknown) => {
      console.warn(
        "[App] failed to list closed task identities:",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    });
    return tasks.filter((task) => repoIds.has(task.repo_id));
  }, []);

  const localTaskIdentitiesForRemoteFiltering = computed<LocalTaskIdentity[]>(() => [
    ...store.items.map((item) => ({
      id: item.id,
      repo_id: item.repo_id,
      stage: item.stage,
      closed_at: item.closed_at,
    })),
    ...closedLocalTaskIdentities.value.map((item) => ({
      ...item,
      stage: "closed",
      closed_at: "",
    })),
  ]);

  const remoteSnapshot = computed<DesktopCloudSnapshot>(() => ({
    repos: [...cloudSnapshot.value.repos, ...lanSnapshot.value.repos],
    items: [...cloudSnapshot.value.items, ...lanSnapshot.value.items]
      .filter((item) => {
        const terminalRef = cloudSnapshot.value.terminalRefs[item.id] ?? lanSnapshot.value.terminalRefs[item.id];
        return !remoteTaskIsLocallyClosed(item, terminalRef, locallyClosedRemoteTaskIds.value);
      }),
    terminalRefs: Object.fromEntries(
      Object.entries({ ...cloudSnapshot.value.terminalRefs, ...lanSnapshot.value.terminalRefs })
        .filter(([taskId, ref]) =>
          !remoteTaskIsLocallyClosed({ id: taskId }, ref, locallyClosedRemoteTaskIds.value),
        ),
    ),
  }));

  const workspace = computed(() => buildWorkspace({
    localRepos: localReposForCloudMatching.value,
    localItems: store.items,
    localClosedItems: closedLocalTaskIdentities.value,
    cloudSnapshot: filterClosedRemoteSnapshot(cloudSnapshot.value),
    lanSnapshot: filterClosedRemoteSnapshot(lanSnapshot.value),
  }));
  const remoteTaskDiagnostics = computed(() => workspace.value.diagnostics);
  const workspaceTasksByItemId = computed(() => {
    const entries: Array<[string, WorkspaceTask]> = [];
    for (const task of workspace.value.tasks) {
      entries.push([task.item.id, task]);
      if (task.localTaskId) entries.push([task.localTaskId, task]);
      for (const remoteTaskId of task.remoteTaskIds) entries.push([remoteTaskId, task]);
    }
    return new Map(entries);
  });
  const sidebarRepos = computed(() => workspace.value.repos.map((repo) => ({
    id: repo.key,
    path: repo.path ?? "cloud",
    name: repo.name,
    remote_url: repo.remoteUrl,
    remote_url_hash: repo.remoteUrlHash,
    default_branch: repo.defaultBranch ?? "main",
    hidden: 0,
    sort_order: 0,
    created_at: "",
    last_opened_at: "",
  })));
  const sidebarItems = computed<AppSidebarItem[]>(() => workspace.value.tasks.map((task) => ({
    ...task.item,
    id: task.item.id,
    repo_id: task.repoKey,
    remote_task: task.owner.kind !== "local",
  })));
  const selectedCloudRepo = computed(() =>
    remoteSnapshot.value.repos.find((repo) => repo.id === (selectedCloudRepoId.value ?? store.selectedRepoId))
      ?? sidebarRepos.value.find((repo) => repo.id === (selectedCloudRepoId.value ?? store.selectedRepoId) && repo.path === "cloud")
      ?? null,
  );
  const selectedCloudItem = computed(() => {
    const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
    if (!selectedItemId) return null;
    const task = workspaceTasksByItemId.value.get(selectedItemId);
    if (!task || task.owner.kind === "local") return null;
    if (task.item.repo_id === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
    if (task.repoKey === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
    return null;
  });
  const mainPanelRepo = computed(() => selectedCloudRepo.value ?? store.selectedRepo);
  const mainPanelItem = computed(() => selectedCloudItem.value ?? store.currentItem);
  const mainPanelIsCloudTask = computed(() => Boolean(selectedCloudItem.value));
  const selectedWorkspaceTask = computed(() => {
    const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
    return selectedItemId ? workspaceTasksByItemId.value.get(selectedItemId) ?? null : null;
  });
  const mainPanelCloudTerminalRef = computed(() => {
    const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
    if (!selectedItemId) return null;
    const task = workspaceTasksByItemId.value.get(selectedItemId);
    return task?.terminal.remoteRef ?? null;
  });

  function isCloudOnlyRepoId(repoId: string | undefined | null): boolean {
    return Boolean(repoId && remoteSnapshot.value.repos.some((repo) => repo.id === repoId));
  }

  function cloudRepoRemoteUrl(repoId: string | undefined | null): string | null {
    if (!repoId) return null;
    const repo = remoteSnapshot.value.repos.find((candidate) => candidate.id === repoId);
    return repo?.remote_url ?? null;
  }

  function filterClosedRemoteSnapshot(snapshot: DesktopCloudSnapshot): DesktopCloudSnapshot {
    const closedIds = locallyClosedRemoteTaskIds.value;
    if (closedIds.size === 0) return snapshot;
    return {
      repos: snapshot.repos,
      items: snapshot.items.filter((item) =>
        !remoteTaskIsLocallyClosed(item, snapshot.terminalRefs[item.id], closedIds),
      ),
      terminalRefs: Object.fromEntries(
        Object.entries(snapshot.terminalRefs).filter(([taskId, ref]) =>
          !remoteTaskIsLocallyClosed({ id: taskId }, ref, closedIds),
        ),
      ),
    };
  }

  function markWorkspaceTaskLocallyClosed(workspaceTask: WorkspaceTask): void {
    const closedAliases = new Set<string>();
    for (const source of workspaceTask.sources) {
      for (const alias of remoteTaskClosureAliases({ id: source.taskId }, source.terminalRef)) {
        closedAliases.add(alias);
      }
    }
    if (workspaceTask.terminal.remoteRef) {
      for (const alias of remoteTaskClosureAliases(workspaceTask.item, workspaceTask.terminal.remoteRef)) {
        closedAliases.add(alias);
      }
    } else {
      closedAliases.add(workspaceTask.item.id);
    }
    locallyClosedRemoteTaskIds.value = new Set([
      ...locallyClosedRemoteTaskIds.value,
      ...closedAliases,
    ]);
  }

  function showCloudBackendErrorToast(error: unknown) {
    const now = Date.now();
    if (
      lastCloudBackendErrorToastAt !== null
      && now - lastCloudBackendErrorToastAt < CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS
    ) {
      return;
    }
    lastCloudBackendErrorToastAt = now;
    toast.error(`Cloud sync failed: ${cloudBackendErrorLabel(error)}`);
  }

  function cloudBackendErrorLabel(error: unknown): string {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) return code.trim();
    }
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return String(error);
  }

  async function refreshCloudTasksForSignedInUser(): Promise<void> {
    const state = desktopAuthState.value;
    if (state.status !== "signedIn") {
      cloudSnapshot.value = { repos: [], items: [], terminalRefs: {} };
      return;
    }
    const snapshot = await listDesktopCloudTasks(state.user.uid, undefined, {
      localRepos: localReposForCloudMatching.value,
      localItems: localTaskIdentitiesForRemoteFiltering.value,
      localClosedItems: closedLocalTaskIdentities.value,
    });
    cloudSnapshot.value = {
      repos: snapshot.repos,
      items: snapshot.items,
      terminalRefs: snapshot.terminalRefs ?? {},
    };
  }

  function startCloudTaskSubscription(uid: string): void {
    if (subscribedCloudUid === uid && cloudTasksUnsubscribe) return;
    stopCloudTaskSubscription();
    subscribedCloudUid = uid;
    cloudTasksUnsubscribe = subscribeDesktopCloudTasks(
      uid,
      (snapshot) => {
        cloudSnapshot.value = {
          repos: snapshot.repos,
          items: snapshot.items,
          terminalRefs: snapshot.terminalRefs ?? {},
        };
      },
      {
        getOptions: () => ({
          localRepos: localReposForCloudMatching.value,
          localItems: localTaskIdentitiesForRemoteFiltering.value,
          localClosedItems: closedLocalTaskIdentities.value,
        }),
      },
    );
  }

  function stopCloudTaskSubscription(): void {
    cloudTasksUnsubscribe?.();
    cloudTasksUnsubscribe = null;
    subscribedCloudUid = null;
  }

  // Publish (reconcile) only when the local open-task set actually changed.
  // Writes are event-driven now — no periodic reconcile poll.
  function publishLocalTaskChangesIfNeeded(): void {
    if (desktopAuthState.value.status !== "signedIn") return;
    const fingerprint = computeTaskSnapshotFingerprint(store.items);
    if (fingerprint === lastPublishedTaskFingerprint) return;
    lastPublishedTaskFingerprint = fingerprint;
    void reconcileDesktopTaskSnapshots(db).catch((error) => {
      console.warn("[cloud] failed to publish local task snapshot change:", error);
      showCloudBackendErrorToast(error);
    });
  }

  watch(
    () => computeTaskSnapshotFingerprint(store.items),
    () => publishLocalTaskChangesIfNeeded(),
  );

  async function refreshLanTasks(): Promise<void> {
    await publishDesktopLanTaskSnapshot(db);
    const snapshot = await listDesktopLanTasks({
      localRepos: localReposForCloudMatching.value,
      localClosedItems: closedLocalTaskIdentities.value,
    });
    lanSnapshot.value = {
      repos: snapshot.repos,
      items: snapshot.items,
      terminalRefs: snapshot.terminalRefs ?? {},
    };
  }

  async function initializeDesktopCloudAuth(): Promise<void> {
    const session = await getConfiguredDesktopAuthSession();
    desktopAuthSession.value = session;
    await session.initialize();
    unsubscribeDesktopAuth?.();
    unsubscribeDesktopAuth = session.subscribe((state) => {
      desktopAuthState.value = state;
      if (state.status === "signedIn") {
        if (!reconciledCloudSnapshotUsers.has(state.user.uid)) {
          reconciledCloudSnapshotUsers.add(state.user.uid);
          void reconcileDesktopTaskSnapshots(db)
            .then(() => {
              // Seed the fingerprint so the change watcher doesn't immediately
              // republish what we just reconciled on sign-in.
              lastPublishedTaskFingerprint = computeTaskSnapshotFingerprint(store.items);
            })
            .catch((error) => {
              console.warn("[cloud] failed to reconcile local task snapshots:", error);
              showCloudBackendErrorToast(error);
            });
        }
        // One-shot read for immediate data, then live onSnapshot updates.
        void refreshCloudTasksForSignedInUser().catch((error) => {
          console.warn("[cloud] failed to refresh cloud tasks:", error);
          showCloudBackendErrorToast(error);
        });
        startCloudTaskSubscription(state.user.uid);
      } else {
        stopCloudTaskSubscription();
        cloudSnapshot.value = { repos: [], items: [], terminalRefs: {} };
      }
    });
    void runDesktopAutoSignIn({
      dev: import.meta.env.DEV,
      session,
      getState: () => desktopAuthState.value,
      readEnv: (name) => invoke<string>("read_env_var", { name }),
    });
  }

  function initializeDesktopLanTaskSync(): void {
    void refreshLanTasks().catch((error) =>
      console.warn("[lan] failed to refresh LAN tasks:", error),
    );
    lanRefreshTimer = setInterval(() => {
      void refreshLanTasks().catch((error) =>
        console.warn("[lan] failed to refresh LAN tasks:", error),
      );
    }, 1000);
  }

  async function closeSelectedWorkspaceTask(): Promise<void> {
    const workspaceTask = selectedWorkspaceTask.value;
    if (!workspaceTask || workspaceTask.terminal.kind === "local") {
      if (workspaceTask) {
        markWorkspaceTaskLocallyClosed(workspaceTask);
      }
      await store.closeTask();
      return;
    }

    const remoteRef = workspaceTask.terminal.remoteRef;
    if (!remoteRef || !workspaceTask.capabilities.canClose) {
      toast.error("Remote task is not reachable.");
      return;
    }

    const client = workspaceTask.terminal.kind === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (!client) {
      toast.error("Remote task owner is unavailable.");
      return;
    }

    try {
      await client.closeTask({
        desktopId: remoteRef.ownerDesktopId,
        taskId: remoteRef.ownerLocalTaskId,
      });
      deleteRemoteCloudTaskMetadata(workspaceTask);
      markWorkspaceTaskLocallyClosed(workspaceTask);
      if (selectedCloudItemId.value && locallyClosedRemoteTaskIds.value.has(selectedCloudItemId.value)) {
        selectedCloudItemId.value = null;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      client.close();
    }
  }

  function deleteRemoteCloudTaskMetadata(workspaceTask: WorkspaceTask): void {
    for (const source of workspaceTask.sources) {
      if (source.kind !== "cloud" || !source.terminalRef) continue;
      void deleteRemoteTaskSnapshots({
        ownerDesktopId: source.terminalRef.ownerDesktopId,
        localRepoId: source.terminalRef.ownerLocalRepoId
          ?? resolveRemoteCloseLocalRepoId(workspaceTask, source.taskId, source.terminalRef.ownerLocalTaskId),
        ownerLocalTaskId: source.terminalRef.ownerLocalTaskId,
      }).catch((error) => {
        console.warn("[cloud] failed to delete remote task metadata:", error);
      });
    }
  }

  function resolveRemoteCloseLocalRepoId(
    workspaceTask: WorkspaceTask,
    sourceTaskId: string,
    ownerLocalTaskId: string,
  ): string {
    if (!workspaceTask.item.repo_id.startsWith("cloud:")) return workspaceTask.item.repo_id;
    const unprefixed = sourceTaskId.startsWith("cloud:")
      ? sourceTaskId.slice("cloud:".length)
      : sourceTaskId;
    const suffix = `:${ownerLocalTaskId}`;
    return unprefixed.endsWith(suffix)
      ? unprefixed.slice(0, -suffix.length)
      : workspaceTask.item.repo_id.slice("cloud:".length);
  }

  async function advanceSelectedRemoteWorkspaceTask(
    workspaceTask: NonNullable<ComputedRef<WorkspaceTask | null>["value"]>,
  ): Promise<void> {
    const remoteRef = workspaceTask.terminal.remoteRef;
    if (!remoteRef || !workspaceTask.capabilities.canAdvanceStage) {
      toast.error("Remote task is not reachable.");
      return;
    }

    const client = workspaceTask.terminal.kind === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (!client) {
      toast.error("Remote task owner is unavailable.");
      return;
    }

    try {
      await client.advanceStage({
        desktopId: remoteRef.ownerDesktopId,
        taskId: remoteRef.ownerLocalTaskId,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      client.close();
    }
  }

  function disposeDesktopCloudWorkspace(): void {
    unsubscribeDesktopAuth?.();
    stopCloudTaskSubscription();
    if (lanRefreshTimer) {
      clearInterval(lanRefreshTimer);
    }
  }

  return {
    desktopAuthSession,
    desktopAuthState,
    cloudSnapshot,
    lanSnapshot,
    locallyClosedRemoteTaskIds,
    selectedCloudRepoId,
    selectedCloudItemId,
    localReposForCloudMatching,
    remoteSnapshot,
    workspace,
    remoteTaskDiagnostics,
    workspaceTasksByItemId,
    sidebarRepos,
    sidebarItems,
    selectedCloudRepo,
    selectedCloudItem,
    mainPanelRepo,
    mainPanelItem,
    mainPanelIsCloudTask,
    selectedWorkspaceTask,
    mainPanelCloudTerminalRef,
    isCloudOnlyRepoId,
    cloudRepoRemoteUrl,
    markWorkspaceTaskLocallyClosed,
    refreshLanTasks,
    initializeDesktopCloudAuth,
    initializeDesktopLanTaskSync,
    closeSelectedWorkspaceTask,
    advanceSelectedRemoteWorkspaceTask,
    disposeDesktopCloudWorkspace,
  };
}
