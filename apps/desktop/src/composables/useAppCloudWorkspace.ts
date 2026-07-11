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
import {
  deleteRemoteTaskSnapshots,
  fenceAndDrainDesktopCloudWrites,
  publishDesktopWaitingPromptSnippet,
  reconcileDesktopTaskSnapshots,
  resumeDesktopCloudWrites,
} from "../services/desktopCloudPublisher";
import { createWaitingPromptPublishQueue } from "../services/waitingPromptPublishQueue";
import { getCachedRepoRemoteMetadata } from "../services/repoRemoteUrl";
import { createConfiguredDesktopRelayTerminalClient } from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";
import { fetchClosedTaskIdentities } from "../services/desktopServerClient";
import { computeTaskSnapshotFingerprint } from "../utils/cloudTaskFingerprint";
import { remoteTaskClosureAliases, remoteTaskIsLocallyClosed } from "../utils/remoteTaskIdentity";
import { buildWorkspace } from "../workspace/buildWorkspace";
import type { WorkspaceTask } from "../workspace/types";
import type { useKannaStore } from "../stores/kanna";
import {
  WINDOW_WORKSPACE_MEMBERSHIP_REASON,
  type WindowWorkspaceController,
} from "../windowWorkspace";
import type { useToast } from "./useToast";

export function hasLocalTaskSelectionIdentity(input: {
  selectedRepoId: string | null;
  selectedItemId: string | null;
  items: ReadonlyArray<{ id: string; repo_id: string }>;
  initializingTaskItems: ReadonlyArray<{ id: string; repo_id: string }>;
}): boolean {
  if (!input.selectedRepoId || !input.selectedItemId) return false;
  return input.initializingTaskItems.some((item) =>
    item.id === input.selectedItemId && item.repo_id === input.selectedRepoId)
    || input.items.some((item) =>
      item.id === input.selectedItemId && item.repo_id === input.selectedRepoId);
}

export type AppSidebarItem = PipelineItem & {
  remote_task?: boolean;
};

type LocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id" | "stage" | "closed_at">;
type ClosedLocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id">;

interface UseAppCloudWorkspaceOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  windowWorkspace: WindowWorkspaceController | undefined;
}

const CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS = 30_000;

export function useAppCloudWorkspace({
  db,
  store,
  toast,
  windowWorkspace,
}: UseAppCloudWorkspaceOptions) {
  const desktopAuthSession = ref<DesktopAuthSession | null>(null);
  const desktopAuthState = ref<DesktopAuthState>({ status: "signedOut" });
  const cloudSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
  const lanSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
  const locallyClosedRemoteTaskIds = ref<Set<string>>(new Set());
  let unsubscribeDesktopAuth: (() => void) | null = null;
  let unsubscribeWindowMembership: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let subscribedCloudUid: string | null = null;
  let lanRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let reconciledCloudSnapshotUid: string | null = null;
  let lastPublishedTaskFingerprint: string | null = null;
  let lastCloudBackendErrorToastAt: number | null = null;
  let publicationOwnershipGeneration = 0;
  let publicationRelinquished = false;
  let publicationOwnedBeforeRelinquish = false;
  const publishesLocalCloudState = ref(false);
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);
  const waitingPromptPublishQueue = createWaitingPromptPublishQueue({
    delayMs: 5_000,
    publish: async (taskId, value) => {
      if (!publishesLocalCloudState.value) return;
      const item = store.items.find((candidate) => candidate.id === taskId);
      if (!item || item.closed_at !== null) return;
      await publishDesktopWaitingPromptSnippet({
        localRepoId: item.repo_id,
        ownerLocalTaskId: item.id,
        waitingPromptSnippet: value,
      });
    },
    onError: (error) => {
      console.warn("[cloud] failed to publish waiting prompt:", error);
      showCloudBackendErrorToast(error);
    },
  });

  const localReposForCloudMatching = computedAsync(async () => {
    return Promise.all(store.repos.map(async (repo) => {
      const metadata = await getCachedRepoRemoteMetadata(repo);
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
  const localTaskSelectionOwnsIdentity = computed(() => hasLocalTaskSelectionIdentity({
    selectedRepoId: store.selectedRepoId,
    selectedItemId: store.selectedItemId,
    items: store.items,
    initializingTaskItems: store.initializingTaskItems,
  }));
  const localInitializingTaskOwnsIdentity = computed(() => Boolean(
    store.selectedRepoId
    && store.selectedItemId
    && store.initializingTaskItems.some((item) =>
      item.id === store.selectedItemId && item.repo_id === store.selectedRepoId),
  ));
  watch(localTaskSelectionOwnsIdentity, (ownsIdentity) => {
    if (!ownsIdentity) return;
    selectedCloudRepoId.value = null;
    selectedCloudItemId.value = null;
  }, { flush: "sync" });
  const effectiveWorkspaceRepoId = computed(() => localTaskSelectionOwnsIdentity.value
    ? store.selectedRepoId
    : selectedCloudRepoId.value ?? store.selectedRepoId);
  const effectiveWorkspaceItemId = computed(() => {
    if (localInitializingTaskOwnsIdentity.value) return null;
    if (localTaskSelectionOwnsIdentity.value) return store.selectedItemId;
    return selectedCloudItemId.value ?? store.selectedItemId;
  });
  const selectedCloudRepo = computed(() => {
    if (localTaskSelectionOwnsIdentity.value) return null;
    return remoteSnapshot.value.repos.find((repo) => repo.id === effectiveWorkspaceRepoId.value)
      ?? sidebarRepos.value.find((repo) => repo.id === effectiveWorkspaceRepoId.value && repo.path === "cloud")
      ?? null;
  });
  const selectedCloudItem = computed(() => {
    if (localTaskSelectionOwnsIdentity.value) return null;
    const selectedItemId = effectiveWorkspaceItemId.value;
    if (!selectedItemId) return null;
    const task = workspaceTasksByItemId.value.get(selectedItemId);
    if (!task || task.owner.kind === "local") return null;
    if (task.item.repo_id === effectiveWorkspaceRepoId.value) return task.item;
    if (task.repoKey === effectiveWorkspaceRepoId.value) return task.item;
    return null;
  });
  const mainPanelRepo = computed(() => selectedCloudRepo.value ?? store.selectedRepo);
  const mainPanelItem = computed(() => selectedCloudItem.value ?? store.currentItem);
  const mainPanelIsCloudTask = computed(() => Boolean(selectedCloudItem.value));
  const selectedWorkspaceTask = computed(() => {
    const selectedItemId = effectiveWorkspaceItemId.value;
    return selectedItemId ? workspaceTasksByItemId.value.get(selectedItemId) ?? null : null;
  });
  const mainPanelCloudTerminalRef = computed(() => {
    if (localTaskSelectionOwnsIdentity.value) return null;
    const selectedItemId = effectiveWorkspaceItemId.value;
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
    if (!publishesLocalCloudState.value || desktopAuthState.value.status !== "signedIn") return;
    const fingerprint = computeTaskSnapshotFingerprint(store.items);
    if (fingerprint === lastPublishedTaskFingerprint) return;
    lastPublishedTaskFingerprint = fingerprint;
    const waitingPrompts = captureWaitingPrompts();
    void reconcileDesktopTaskSnapshots(db)
      .then(() => seedUnchangedWaitingPrompts(waitingPrompts))
      .catch((error) => {
        console.warn("[cloud] failed to publish local task snapshot change:", error);
        showCloudBackendErrorToast(error);
      });
  }

  function captureWaitingPrompts(): Map<string, string | null> {
    return new Map(
      store.items
        .filter((item) => item.closed_at === null)
        .map((item) => [item.id, item.last_output_preview]),
    );
  }

  function seedUnchangedWaitingPrompts(prompts: Map<string, string | null>): void {
    for (const [taskId, prompt] of prompts) {
      const current = store.items.find((item) => item.id === taskId);
      if (
        current?.closed_at === null
        && current.last_output_preview === prompt
      ) {
        waitingPromptPublishQueue.seed(taskId, prompt);
      }
    }
  }

  watch(
    () => computeTaskSnapshotFingerprint(store.items),
    () => publishLocalTaskChangesIfNeeded(),
  );

  watch(
    () => store.items.map((item) => ({
      id: item.id,
      closedAt: item.closed_at,
      prompt: item.last_output_preview,
    })),
    (items, previous = []) => {
      const currentIds = new Set(items.map((item) => item.id));
      for (const previousItem of previous) {
        if (!currentIds.has(previousItem.id)) {
          waitingPromptPublishQueue.cancel(previousItem.id);
        }
      }

      const previousById = new Map(previous.map((item) => [item.id, item]));
      for (const item of items) {
        if (item.closedAt !== null) {
          waitingPromptPublishQueue.cancel(item.id);
          continue;
        }
        if (
          !publishesLocalCloudState.value
          || desktopAuthState.value.status !== "signedIn"
          || !item.prompt
        ) continue;
        if (previousById.get(item.id)?.prompt !== item.prompt) {
          waitingPromptPublishQueue.schedule(item.id, item.prompt);
        }
      }
    },
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

  function resetLocalCloudPublicationState(): void {
    reconciledCloudSnapshotUid = null;
    lastPublishedTaskFingerprint = null;
    for (const item of store.items) {
      waitingPromptPublishQueue.cancel(item.id);
    }
  }

  function reconcileSignedInLocalCloudState(uid: string): void {
    if (
      !publishesLocalCloudState.value
      || reconciledCloudSnapshotUid === uid
    ) {
      return;
    }

    reconciledCloudSnapshotUid = uid;
    const taskFingerprint = computeTaskSnapshotFingerprint(store.items);
    const waitingPrompts = captureWaitingPrompts();
    void reconcileDesktopTaskSnapshots(db)
      .then(() => {
        const currentAuthState = desktopAuthState.value;
        if (
          !publishesLocalCloudState.value
          || currentAuthState.status !== "signedIn"
          || currentAuthState.user.uid !== uid
        ) {
          return;
        }
        // Seed only the exact state included in this reconciliation. Changes
        // that landed while it was in flight retain their own publication.
        if (computeTaskSnapshotFingerprint(store.items) === taskFingerprint) {
          lastPublishedTaskFingerprint = taskFingerprint;
        }
        seedUnchangedWaitingPrompts(waitingPrompts);
      })
      .catch((error) => {
        if (
          publishesLocalCloudState.value
          && desktopAuthState.value.status === "signedIn"
          && desktopAuthState.value.user.uid === uid
        ) {
          reconciledCloudSnapshotUid = null;
        }
        console.warn("[cloud] failed to reconcile local task snapshots:", error);
        showCloudBackendErrorToast(error);
      });
  }

  async function refreshLocalCloudPublicationOwnership(
    fallbackOwnership?: boolean,
  ): Promise<void> {
    const generation = ++publicationOwnershipGeneration;
    if (publicationRelinquished) return;
    let ownsPublication = false;

    if (windowWorkspace) {
      try {
        const snapshot = await windowWorkspace.loadSnapshot();
        const leader = [...snapshot.windows]
          .sort((left, right) => left.order - right.order)[0];
        ownsPublication = leader?.windowId === windowWorkspace.bootstrap.windowId;
      } catch (error) {
        // Preserve the historical main-window fallback if workspace state is
        // temporarily unreadable. A later membership event retries election.
        ownsPublication = fallbackOwnership
          ?? windowWorkspace.bootstrap.windowId === "main";
        console.warn("[cloud] failed to elect local snapshot publisher:", error);
      }
    }

    if (generation !== publicationOwnershipGeneration || publicationRelinquished) return;
    if (publishesLocalCloudState.value === ownsPublication) return;

    publishesLocalCloudState.value = ownsPublication;
    if (!ownsPublication) {
      resetLocalCloudPublicationState();
      return;
    }

    if (desktopAuthState.value.status === "signedIn") {
      reconcileSignedInLocalCloudState(desktopAuthState.value.user.uid);
    }
  }

  async function initializeDesktopCloudAuth(): Promise<void> {
    publicationRelinquished = false;
    resumeDesktopCloudWrites();
    unsubscribeWindowMembership?.();
    unsubscribeWindowMembership = windowWorkspace
      ? await windowWorkspace.onSharedInvalidation(async (payload) => {
          if (payload.reason === WINDOW_WORKSPACE_MEMBERSHIP_REASON) {
            await refreshLocalCloudPublicationOwnership();
          }
        })
      : null;
    await refreshLocalCloudPublicationOwnership();

    const session = await getConfiguredDesktopAuthSession();
    desktopAuthSession.value = session;
    await session.initialize();
    unsubscribeDesktopAuth?.();
    unsubscribeDesktopAuth = session.subscribe((state) => {
      desktopAuthState.value = state;
      if (state.status === "signedIn") {
        reconcileSignedInLocalCloudState(state.user.uid);
        // One-shot read for immediate data, then live onSnapshot updates.
        void refreshCloudTasksForSignedInUser().catch((error) => {
          console.warn("[cloud] failed to refresh cloud tasks:", error);
          showCloudBackendErrorToast(error);
        });
        startCloudTaskSubscription(state.user.uid);
      } else {
        resetLocalCloudPublicationState();
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

  async function relinquishDesktopCloudWorkspace(): Promise<void> {
    publicationOwnedBeforeRelinquish = publishesLocalCloudState.value;
    publicationRelinquished = true;
    publicationOwnershipGeneration += 1;
    publishesLocalCloudState.value = false;
    resetLocalCloudPublicationState();
    await fenceAndDrainDesktopCloudWrites();
  }

  async function resumeDesktopCloudWorkspace(): Promise<void> {
    resumeDesktopCloudWrites();
    publicationRelinquished = false;
    try {
      await windowWorkspace?.initialize();
    } catch (error) {
      // A failed close normally means the membership row is still present.
      // Continue election with the ownership we held before relinquishing so
      // a simultaneous server outage cannot strand every live window read-only.
      console.warn("[cloud] failed to restore window workspace membership:", error);
    }
    await refreshLocalCloudPublicationOwnership(publicationOwnedBeforeRelinquish);
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
    publicationRelinquished = true;
    publicationOwnershipGeneration += 1;
    publishesLocalCloudState.value = false;
    resetLocalCloudPublicationState();
    void fenceAndDrainDesktopCloudWrites().catch((error) => {
      console.warn("[cloud] timed out draining writes during disposal:", error);
    });
    unsubscribeDesktopAuth?.();
    unsubscribeWindowMembership?.();
    stopCloudTaskSubscription();
    waitingPromptPublishQueue.dispose();
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
    relinquishDesktopCloudWorkspace,
    resumeDesktopCloudWorkspace,
    disposeDesktopCloudWorkspace,
  };
}
