import { computed, ref, watchEffect, type ComputedRef } from "vue";
import { computedAsync } from "@vueuse/core";
import type { DbHandle, PipelineItem } from "../types/kanna";
import type { SidebarTaskItem } from "../types/taskUi";

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
import { associateDesktopCloudCredential } from "../services/desktopCloudAssociation";
import { isDesktopCloudCredentialConflict } from "../services/desktopCloudCredentialConflict";
import { getCachedRepoRemoteMetadata } from "../services/repoRemoteUrl";
import {
  createConfiguredDesktopRelayTerminalClient,
  type DesktopRelayTerminalClient,
} from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "../services/desktopLanTerminal";
import {
  fetchClosedTaskIdentities,
  putDesktopCloudTransferIdentity,
  type DesktopCloudTransferIdentity,
} from "../services/desktopServerClient";
import {
  createDesktopTransferMachineSync,
  parseLanTransferPeers,
  resolveCloudTransferRelayUrl,
  type TransferMachine,
} from "../services/desktopTransferMachines";
import {
  parseRemoteTaskPins,
  pinRemoteTask,
  reorderRemoteTaskPins,
  unpinRemoteTask,
} from "../services/remoteTaskPins";
import { remoteTaskClosureAliases, remoteTaskIsLocallyClosed } from "../utils/remoteTaskIdentity";
import { buildWorkspace, workspaceTaskOwnerTaskId } from "../workspace/buildWorkspace";
import { createWorkspaceSidebarProjector } from "../workspace/projectWorkspaceTasksForSidebar";
import { projectWorkspaceBlockers } from "../workspace/projectWorkspaceBlockers";
import type { WorkspaceTask } from "../workspace/types";
import type { useKannaStore } from "../stores/kanna";
import type { WindowWorkspaceController } from "../windowWorkspace";
import { useRemoteTaskReadDwell } from "./useRemoteTaskReadDwell";
import type { useToast } from "./useToast";

export type AppSidebarItem = SidebarTaskItem;

type LocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id" | "stage" | "closed_at">;
type ClosedLocalTaskIdentity = Pick<PipelineItem, "id" | "repo_id">;

interface UseAppCloudWorkspaceOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  windowWorkspace: WindowWorkspaceController;
}

interface ActiveMarkReadClient {
  client: DesktopRelayTerminalClient;
  closed: boolean;
}

interface RemoteStageAdvancePending {
  expectedTransitionRevision: string | null;
  sourceGeneration: number;
  sourceKind: "cloud" | "lan";
  sourceRepoId: string;
  sourceTaskId: string;
  ownerDesktopId: string;
  ownerTaskId: string;
}

const CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS = 30_000;
const REMOTE_MARK_READ_TIMEOUT_MS = 10_000;

export function useAppCloudWorkspace({ db, store, toast, windowWorkspace }: UseAppCloudWorkspaceOptions) {
  const desktopAuthSession = ref<DesktopAuthSession | null>(null);
  const desktopAuthState = ref<DesktopAuthState>({ status: "signedOut" });
  const cloudSnapshot = ref<DesktopCloudSnapshot>({
    repos: [],
    items: [],
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  });
  const lanSnapshot = ref<DesktopCloudSnapshot>({
    repos: [],
    items: [],
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  });
  const cloudAuthoritativeGeneration = ref(0);
  const lanAuthoritativeGeneration = ref(0);
  const locallyClosedRemoteTaskIds = ref<Set<string>>(new Set());
  let unsubscribeDesktopAuth: (() => void) | null = null;
  let cloudTasksUnsubscribe: (() => void) | null = null;
  let subscribedCloudUid: string | null = null;
  let cloudSubscriptionGeneration = 0;
  let cloudSnapshotRevision = 0;
  let cloudOneShotGeneration = 0;
  let lanRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let lanRefreshInFlight: Promise<void> | null = null;
  let desktopCloudWorkspaceDisposed = false;
  const activeMarkReadClients = new Set<ActiveMarkReadClient>();
  const remoteStageAdvancesPending = new Map<string, RemoteStageAdvancePending>();
  const associatedCloudUsers = new Set<string>();
  const cloudCredentialConflictUsers = new Set<string>();
  const shownLanPeerIssues = new Set<string>();
  let e2eLanRefreshFrozen = false;
  let e2eNextRemoteActionFailure: string | null = null;
  let lastCloudBackendErrorToastAt: number | null = null;
  let currentDesktopId: string | null = null;
  const transferMachineRevision = ref(0);
  let hadSignedInTransferSession = false;
  const selectedCloudRepoId = ref<string | null>(null);
  const selectedCloudItemId = ref<string | null>(null);
  const workspaceSidebarProjector = createWorkspaceSidebarProjector();
  const transferMachineSync = createDesktopTransferMachineSync({
    getTransferIdentity: async () =>
      parseTransferIdentity(await invoke<unknown>("get_transfer_identity")),
    putLocalIdentity: putDesktopCloudTransferIdentity,
    resolveRelayUrl: () => resolveCloudTransferRelayUrl(
      async (name) => {
        const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
        return typeof value === "string" ? value : "";
      },
      import.meta.env.DEV,
    ),
    ensureProxy: (input) => invoke("ensure_cloud_transfer_proxy", input),
    removeProxy: (input) => invoke("remove_cloud_transfer_proxy", input),
    clearProxies: () => invoke("clear_cloud_transfer_proxies"),
    upsertExternalPeer: ({ peer }) => invoke("upsert_external_transfer_peer", {
      peer: {
        peer_id: peer.peerId,
        display_name: peer.displayName,
        endpoint: peer.endpoint,
        public_key: peer.publicKey,
        protocol_version: peer.protocolVersion,
        accepting_transfers: peer.acceptingTransfers,
      },
    }),
    removeExternalPeer: (input) => invoke("remove_external_transfer_peer", input),
    clearExternalPeers: () => invoke("clear_external_transfer_peers"),
  });
  const transferMachines = computed<TransferMachine[]>(() => {
    void transferMachineRevision.value;
    return transferMachineSync.getTransferMachines();
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
    blockedByTaskIds: {
      ...cloudSnapshot.value.blockedByTaskIds,
      ...lanSnapshot.value.blockedByTaskIds,
    },
    transferMachines: cloudSnapshot.value.transferMachines,
  }));

  const remoteTaskPins = computed(() => parseRemoteTaskPins(store.snapshotSettings));
  const repoSidebarOrder = computed(
    () => new Map(Object.entries(store.repoSidebarOrder)),
  );

  const workspace = computed(() => buildWorkspace({
    localRepos: localReposForCloudMatching.value,
    localItems: store.items,
    localClosedItems: closedLocalTaskIdentities.value,
    cloudSnapshot: filterClosedRemoteSnapshot(cloudSnapshot.value),
    lanSnapshot: filterClosedRemoteSnapshot(lanSnapshot.value),
    remoteTaskPins: remoteTaskPins.value,
    repoSidebarOrder: repoSidebarOrder.value,
  }));
  watchEffect(() => {
    const cloudGeneration = cloudAuthoritativeGeneration.value;
    const lanGeneration = lanAuthoritativeGeneration.value;
    const tasks = workspace.value.tasks;
    for (const [requestKey, pending] of remoteStageAdvancesPending) {
      const task = tasks.find((candidate) =>
        candidate.owner.kind === "remote"
        && candidate.sources.some((source) =>
          source.terminalRef?.ownerDesktopId === pending.ownerDesktopId
          && source.terminalRef.ownerLocalTaskId === pending.ownerTaskId
        ),
      );
      const source = task?.sources.find((candidate) =>
        candidate.kind === pending.sourceKind
        && candidate.terminalRef?.ownerDesktopId === pending.ownerDesktopId
        && candidate.terminalRef.ownerLocalTaskId === pending.ownerTaskId
      );
      const sourceGeneration = pending.sourceKind === "cloud"
        ? cloudGeneration
        : lanGeneration;
      const transitionRevision =
        typeof source?.transitionRevision === "string" && source.transitionRevision.trim()
          ? source.transitionRevision.trim()
          : null;
      if (
        !task
        || !source
        || transitionRevision !== pending.expectedTransitionRevision
        || sourceGeneration > pending.sourceGeneration
      ) {
        remoteStageAdvancesPending.delete(requestKey);
      }
    }
  }, { flush: "sync" });
  const remoteTaskDiagnostics = computed(() => workspace.value.diagnostics);
  const workspaceSidebarProjection = computed(() => workspaceSidebarProjector.project({
    taskUiSlots: store.taskUiSlots,
    workspaceTasks: workspace.value.tasks,
  }));
  // Keep admission state ahead of task creation. Vue owns this effect's cleanup
  // through the composable's active component scope.
  watchEffect(() => {
    void workspaceSidebarProjection.value;
  }, { flush: "sync" });
  watchEffect(() => {
    const machines = cloudSnapshot.value.transferMachines;
    void transferMachineSync.setCloudMachines(machines)
      .then((changed) => {
        if (changed) transferMachineRevision.value += 1;
      })
      .catch((error) => {
        console.warn("[cloud] failed to synchronize transfer machines:", error);
      });
  }, { flush: "sync" });
  const workspaceTasksByItemId = computed(
    () => workspaceSidebarProjection.value.workspaceTasksByItemId,
  );
  const workspaceBlockers = computed(() => projectWorkspaceBlockers({
    workspaceTasks: workspace.value.tasks,
    sidebarItems: workspaceSidebarProjection.value.sidebarItems,
    workspaceTasksByItemId: workspaceSidebarProjection.value.workspaceTasksByItemId,
  }));
  const sidebarRepos = computed(() => workspace.value.repos.map((repo) => ({
    id: repo.key,
    path: repo.path ?? "cloud",
    name: repo.name,
    remote_url: repo.remoteUrl,
    remote_url_hash: repo.remoteUrlHash,
    default_branch: repo.defaultBranch ?? "main",
    hidden: 0,
    sort_order: repo.sortOrder,
    created_at: "",
    last_opened_at: "",
  })));
  const sidebarItems = computed<AppSidebarItem[]>(
    () => workspaceSidebarProjection.value.sidebarItems,
  );
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
  const selectedRemoteItemId = computed(() =>
    selectedWorkspaceTask.value?.owner.kind === "remote"
      ? selectedCloudItemId.value ?? store.selectedItemId
      : null,
  );
  useRemoteTaskReadDwell({
    selectedItemId: selectedRemoteItemId,
    workspaceTasksByItemId,
    markTaskRead: markRemoteWorkspaceTaskRead,
  });
  const selectedRemoteBlockers = computed(() => {
    const task = selectedWorkspaceTask.value;
    if (!task || task.owner.kind === "local") return [];
    return workspaceBlockers.value.blockersByLogicalTaskKey[task.logicalTaskKey] ?? [];
  });
  const selectedRemoteTaskIsBlocked = computed(
    () => selectedRemoteBlockers.value.length > 0,
  );
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
    const items = snapshot.items.filter((item) =>
      !remoteTaskIsLocallyClosed(item, snapshot.terminalRefs[item.id], closedIds),
    );
    const retainedTaskIds = new Set(items.map((item) => item.id));
    return {
      repos: snapshot.repos,
      items,
      terminalRefs: Object.fromEntries(
        Object.entries(snapshot.terminalRefs).filter(([taskId, ref]) =>
          !remoteTaskIsLocallyClosed({ id: taskId }, ref, closedIds),
        ),
      ),
      blockedByTaskIds: Object.fromEntries(
        Object.entries(snapshot.blockedByTaskIds).filter(([taskId]) =>
          retainedTaskIds.has(taskId),
        ),
      ),
      transferMachines: snapshot.transferMachines,
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

  /**
   * A credential conflict is a standing state, not a transient backend fault:
   * it stays denied until the account that owns this desktop releases it. Say
   * what to do about it, and say it once per signed-in user rather than on the
   * generic backend-error cadence.
   */
  function showCloudCredentialAssociationErrorToast(uid: string, error: unknown): void {
    if (!isDesktopCloudCredentialConflict(error)) {
      showCloudBackendErrorToast(error);
      return;
    }
    if (cloudCredentialConflictUsers.has(uid)) return;
    cloudCredentialConflictUsers.add(uid);
    toast.error(
      "Cloud sync is off: this desktop is registered to a different Kanna account. "
      + "Sign in as that account and sign out to release it.",
    );
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
      return;
    }
    const uid = state.user.uid;
    const subscriptionGeneration = cloudSubscriptionGeneration;
    const snapshotRevision = cloudSnapshotRevision;
    const oneShotGeneration = ++cloudOneShotGeneration;
    const snapshot = await listDesktopCloudTasks(uid, undefined, {
      localRepos: localReposForCloudMatching.value,
      localItems: localTaskIdentitiesForRemoteFiltering.value,
      localClosedItems: closedLocalTaskIdentities.value,
    });
    const currentState = desktopAuthState.value;
    if (
      currentState.status !== "signedIn"
      || currentState.user.uid !== uid
      || subscribedCloudUid !== uid
      || cloudSubscriptionGeneration !== subscriptionGeneration
      || cloudSnapshotRevision !== snapshotRevision
      || cloudOneShotGeneration !== oneShotGeneration
    ) {
      return;
    }
    cloudSnapshotRevision += 1;
    cloudAuthoritativeGeneration.value += 1;
    cloudSnapshot.value = {
      repos: snapshot.repos,
      items: snapshot.items,
      terminalRefs: snapshot.terminalRefs ?? {},
      blockedByTaskIds: snapshot.blockedByTaskIds ?? {},
      transferMachines: snapshot.transferMachines,
    };
  }

  function startCloudTaskSubscription(uid: string): void {
    if (subscribedCloudUid === uid && cloudTasksUnsubscribe) return;
    stopCloudTaskSubscription();
    subscribedCloudUid = uid;
    const subscriptionGeneration = cloudSubscriptionGeneration;
    cloudTasksUnsubscribe = subscribeDesktopCloudTasks(
      uid,
      (snapshot) => {
        if (
          subscribedCloudUid !== uid
          || cloudSubscriptionGeneration !== subscriptionGeneration
        ) {
          return;
        }
        cloudSnapshotRevision += 1;
        cloudAuthoritativeGeneration.value += 1;
        cloudSnapshot.value = {
          repos: snapshot.repos,
          items: snapshot.items,
          terminalRefs: snapshot.terminalRefs ?? {},
          blockedByTaskIds: snapshot.blockedByTaskIds ?? {},
          transferMachines: snapshot.transferMachines,
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
    cloudSubscriptionGeneration += 1;
    cloudOneShotGeneration += 1;
    cloudTasksUnsubscribe?.();
    cloudTasksUnsubscribe = null;
    subscribedCloudUid = null;
  }

  function refreshLanTasks(): Promise<void> {
    if (import.meta.env.DEV && e2eLanRefreshFrozen) return Promise.resolve();
    if (lanRefreshInFlight) return lanRefreshInFlight;
    const refresh = (async () => {
      await publishDesktopLanTaskSnapshot(db);
      const snapshot = await listDesktopLanTasks({
        localRepos: localReposForCloudMatching.value,
        localClosedItems: closedLocalTaskIdentities.value,
        onPeerIssue: (issue) => {
          const key = `${issue.peerId}:${issue.message}`;
          if (shownLanPeerIssues.has(key)) return;
          shownLanPeerIssues.add(key);
          toast.warning(issue.message);
        },
      });
      if (desktopCloudWorkspaceDisposed || (import.meta.env.DEV && e2eLanRefreshFrozen)) return;
      lanAuthoritativeGeneration.value += 1;
      lanSnapshot.value = {
        repos: snapshot.repos,
        items: snapshot.items,
        terminalRefs: snapshot.terminalRefs ?? {},
        blockedByTaskIds: snapshot.blockedByTaskIds ?? {},
        transferMachines: snapshot.transferMachines,
      };
    })();
    lanRefreshInFlight = refresh.finally(() => {
      lanRefreshInFlight = null;
    });
    return lanRefreshInFlight;
  }

  async function initializeDesktopCloudAuth(): Promise<void> {
    const session = await getConfiguredDesktopAuthSession();
    desktopAuthSession.value = session;
    await session.initialize();
    currentDesktopId = await resolveTransferDesktopId();
    unsubscribeDesktopAuth?.();
    unsubscribeDesktopAuth = session.subscribe((state) => {
      desktopAuthState.value = state;
      if (state.status === "signedIn") {
        hadSignedInTransferSession = true;
        void transferMachineSync.setSignedInSession(session, currentDesktopId)
          .catch((error) => {
            console.warn("[cloud] failed to initialize signed-in transfer session:", error);
          });
        transferMachineRevision.value += 1;
        if (!associatedCloudUsers.has(state.user.uid)) {
          void associateDesktopCloudCredential()
            .then(() => {
              const currentState = desktopAuthState.value;
              if (currentState.status === "signedIn" && currentState.user.uid === state.user.uid) {
                associatedCloudUsers.add(state.user.uid);
              }
            })
            .catch((error) => {
              console.warn("[cloud] failed to associate desktop credential:", error);
              showCloudCredentialAssociationErrorToast(state.user.uid, error);
            });
        }
        startCloudTaskSubscription(state.user.uid);
        // One-shot read supplies immediate data only until a newer live
        // subscription snapshot or auth generation commits.
        void refreshCloudTasksForSignedInUser().catch((error) => {
          console.warn("[cloud] failed to refresh cloud tasks:", error);
          showCloudBackendErrorToast(error);
        });
      } else {
        associatedCloudUsers.clear();
        cloudCredentialConflictUsers.clear();
        stopCloudTaskSubscription();
        cloudSnapshotRevision += 1;
        cloudAuthoritativeGeneration.value += 1;
        cloudSnapshot.value = {
          repos: [],
          items: [],
          terminalRefs: {},
          blockedByTaskIds: {},
          transferMachines: [],
        };
        if (hadSignedInTransferSession) {
          hadSignedInTransferSession = false;
          void transferMachineSync.signOut()
            .then(() => {
              transferMachineRevision.value += 1;
            })
            .catch((error) => {
              console.warn("[cloud] failed to clear transfer machine session:", error);
            });
        }
      }
    });
    void runDesktopAutoSignIn({
      dev: import.meta.env.DEV,
      session,
      getState: () => desktopAuthState.value,
      readEnv: (name) => invoke<string>("read_env_var", { name }),
    });
  }

  async function markTransferSidecarReady(): Promise<void> {
    try {
      await transferMachineSync.markSidecarReady();
      transferMachineRevision.value += 1;
    } catch (error) {
      console.warn("[cloud] failed to initialize transfer machine sync:", error);
    }
  }

  async function refreshCloudTransferRoute(peerId: string): Promise<void> {
    await transferMachineSync.refreshCloudRoute(peerId);
    transferMachineRevision.value += 1;
  }

  function updateLanTransferPeers(rawPeers: unknown): void {
    transferMachineSync.setLanPeers(parseLanTransferPeers(rawPeers));
    transferMachineRevision.value += 1;
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

  function __e2eInjectRemoteSnapshot(
    source: "cloud" | "lan",
    snapshot: DesktopCloudSnapshot,
    options: { freezeLanRefresh?: boolean } = {},
  ): void {
    if (!import.meta.env.DEV) {
      throw new Error("remote snapshot injection is available only in development builds");
    }
    if (source === "cloud") {
      cloudAuthoritativeGeneration.value += 1;
      cloudSnapshot.value = snapshot;
      return;
    }
    e2eLanRefreshFrozen = options.freezeLanRefresh === true;
    if (e2eLanRefreshFrozen) {
      if (lanRefreshTimer) {
        clearInterval(lanRefreshTimer);
        lanRefreshTimer = null;
      }
    }
    lanAuthoritativeGeneration.value += 1;
    lanSnapshot.value = snapshot;
  }

  function __e2eFailNextRemoteAction(message: string): void {
    if (!import.meta.env.DEV) {
      throw new Error("remote action failure injection is available only in development builds");
    }
    e2eNextRemoteActionFailure = message;
  }

  async function closeSelectedWorkspaceTask(
    prepareReplacementAfterItemRemoval: (
      removedItem: AppSidebarItem,
    ) => () => Promise<string | null>,
  ): Promise<boolean> {
    const workspaceTask = selectedWorkspaceTask.value;
    const closingPresentationSlotId = selectedCloudItemId.value ?? store.selectedItemId;
    const closingSidebarItem = closingPresentationSlotId
      ? sidebarItems.value.find((item) => item.slot_id === closingPresentationSlotId)
        ?? sidebarItems.value.find((item) => item.task_id === closingPresentationSlotId)
        ?? null
      : null;
    if (!workspaceTask || workspaceTask.terminal.kind === "local") {
      const closed = await store.closeTask();
      if (closed && workspaceTask && !store.items.some((item) => item.id === workspaceTask.item.id)) {
        markWorkspaceTaskLocallyClosed(workspaceTask);
      }
      return closed;
    }

    const remoteRef = workspaceTask.terminal.remoteRef;
    if (!remoteRef || !workspaceTask.capabilities.canClose) {
      toast.error("Remote task is not reachable.");
      return false;
    }

    const applyPreparedReplacement = closingSidebarItem
      ? prepareReplacementAfterItemRemoval(closingSidebarItem)
      : null;

    const client = workspaceTask.terminal.kind === "lan"
      ? await createConfiguredDesktopLanTerminalClient()
      : await createConfiguredDesktopRelayTerminalClient();
    if (!client) {
      toast.error("Remote task owner is unavailable.");
      return false;
    }

    try {
      await client.closeTask({
        desktopId: remoteRef.ownerDesktopId,
        taskId: remoteRef.ownerLocalTaskId,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      client.close();
    }

    const pinnedOwnerTaskId = workspaceTaskOwnerTaskId(workspaceTask);
    if (pinnedOwnerTaskId && remoteTaskPins.value.has(pinnedOwnerTaskId)) {
      void unpinRemoteTask(pinnedOwnerTaskId).catch((error) =>
        console.warn("[cloud] failed to drop closed remote task pin:", error),
      );
    }

    try {
      const currentPresentationSlotId = selectedCloudItemId.value ?? store.selectedItemId;
      if (
        closingSidebarItem
        && closingPresentationSlotId
        && currentPresentationSlotId === closingPresentationSlotId
      ) {
        await applyPreparedReplacement?.();
      }
    } catch (error) {
      console.error("[cloud] post-close reconciliation failed:", error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      markWorkspaceTaskLocallyClosed(workspaceTask);
    }
    return true;
  }

  async function advanceSelectedRemoteWorkspaceTask(
    workspaceTask: NonNullable<ComputedRef<WorkspaceTask | null>["value"]>,
  ): Promise<void> {
    const remoteRef = workspaceTask.terminal.remoteRef;
    if (!remoteRef || !workspaceTask.capabilities.canAdvanceStage) {
      toast.error("Remote task is not reachable.");
      return;
    }
    if (workspaceTask.item.has_running_post) return;
    const sourceKind = workspaceTask.terminal.kind === "lan" ? "lan" : "cloud";
    const selectedSource = workspaceTask.sources.find((source) =>
      source.kind === sourceKind
      && source.terminalRef?.ownerDesktopId === remoteRef.ownerDesktopId
      && source.terminalRef.ownerLocalTaskId === remoteRef.ownerLocalTaskId
    );
    if (!selectedSource) {
      toast.error("Remote task source is no longer authoritative.");
      return;
    }
    const expectedTransitionRevision =
      typeof selectedSource.transitionRevision === "string"
      && selectedSource.transitionRevision.trim().length > 0
        ? selectedSource.transitionRevision.trim()
        : null;

    const requestKey = JSON.stringify([
      remoteRef.ownerDesktopId,
      remoteRef.ownerLocalTaskId,
    ]);
    const pending: RemoteStageAdvancePending = {
      expectedTransitionRevision,
      sourceGeneration: sourceKind === "cloud"
        ? cloudAuthoritativeGeneration.value
        : lanAuthoritativeGeneration.value,
      sourceKind,
      sourceRepoId: selectedSource.repoId,
      sourceTaskId: selectedSource.taskId,
      ownerDesktopId: remoteRef.ownerDesktopId,
      ownerTaskId: remoteRef.ownerLocalTaskId,
    };
    const existingPending = remoteStageAdvancesPending.get(requestKey);
    if (
      existingPending
      && existingPending.expectedTransitionRevision === expectedTransitionRevision
    ) return;
    remoteStageAdvancesPending.set(requestKey, pending);

    let client: DesktopRelayTerminalClient | null = null;
    let accepted = false;
    try {
      if (e2eNextRemoteActionFailure) {
        const message = e2eNextRemoteActionFailure;
        e2eNextRemoteActionFailure = null;
        throw new Error(message);
      }
      client = workspaceTask.terminal.kind === "lan"
        ? await createConfiguredDesktopLanTerminalClient()
        : await createConfiguredDesktopRelayTerminalClient();
      if (!client) {
        toast.error("Remote task owner is unavailable.");
        return;
      }
      if (desktopCloudWorkspaceDisposed) return;
      const authoritativeGeneration = pending.sourceKind === "cloud"
        ? cloudAuthoritativeGeneration.value
        : lanAuthoritativeGeneration.value;
      const authoritativeTask = workspace.value.tasks.find((candidate) =>
        candidate.owner.kind === "remote"
        && candidate.sources.some((source) =>
          source.kind === pending.sourceKind
          && source.repoId === pending.sourceRepoId
          && source.taskId === pending.sourceTaskId
          && source.terminalRef?.ownerDesktopId === pending.ownerDesktopId
          && source.terminalRef.ownerLocalTaskId === pending.ownerTaskId
        ),
      );
      const authoritativeSource = authoritativeTask?.sources.find((source) =>
        source.kind === pending.sourceKind
        && source.repoId === pending.sourceRepoId
        && source.taskId === pending.sourceTaskId
        && source.terminalRef?.ownerDesktopId === pending.ownerDesktopId
        && source.terminalRef.ownerLocalTaskId === pending.ownerTaskId
      );
      const authoritativeRevision =
        typeof authoritativeSource?.transitionRevision === "string"
        && authoritativeSource.transitionRevision.trim().length > 0
          ? authoritativeSource.transitionRevision.trim()
          : null;
      if (
        remoteStageAdvancesPending.get(requestKey) !== pending
        || authoritativeGeneration !== pending.sourceGeneration
        || !authoritativeTask
        || !authoritativeSource
        || authoritativeRevision !== pending.expectedTransitionRevision
      ) return;
      await client.advanceStage({
        desktopId: remoteRef.ownerDesktopId,
        taskId: remoteRef.ownerLocalTaskId,
        ...(expectedTransitionRevision
          ? { expectedTransitionRevision }
          : {}),
      });
      accepted = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      client?.close();
      if (
        !accepted
        && remoteStageAdvancesPending.get(requestKey) === pending
      ) {
        remoteStageAdvancesPending.delete(requestKey);
      }
    }
  }

  /**
   * A workspace task that exists only on a remote owner. Its pin state lives
   * in the viewer-local overlay because there is no local pipeline_item row
   * to carry pinned/pin_order. Tasks with a local row use the normal store
   * pin path even when remote duplicates exist.
   */
  function remoteOnlyWorkspaceTask(itemId: string): WorkspaceTask | null {
    const task = workspaceTasksByItemId.value.get(itemId);
    if (!task || task.owner.kind === "local" || task.localTaskId !== null) return null;
    return task;
  }

  function requireRemoteOwnerTaskId(task: WorkspaceTask): string {
    const ownerTaskId = workspaceTaskOwnerTaskId(task);
    if (!ownerTaskId) throw new Error("Remote task identity is unavailable.");
    return ownerTaskId;
  }

  async function refreshAfterRemotePinChange(reason: string): Promise<void> {
    await store.reloadSnapshot();
    await windowWorkspace.invalidateSharedData(reason);
  }

  async function pinSidebarTask(itemId: string, position: number): Promise<void> {
    try {
      const remoteTask = remoteOnlyWorkspaceTask(itemId);
      if (!remoteTask) {
        await store.pinItem(itemId, position);
        return;
      }
      await pinRemoteTask(requireRemoteOwnerTaskId(remoteTask), position);
      await refreshAfterRemotePinChange("pinRemoteTask");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function unpinSidebarTask(itemId: string): Promise<void> {
    try {
      const remoteTask = remoteOnlyWorkspaceTask(itemId);
      if (!remoteTask) {
        await store.unpinItem(itemId);
        return;
      }
      await unpinRemoteTask(requireRemoteOwnerTaskId(remoteTask));
      await refreshAfterRemotePinChange("unpinRemoteTask");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function reorderPinnedSidebarTasks(repoId: string, orderedIds: string[]): Promise<void> {
    try {
      const remoteOrders = new Map<string, number>();
      let hasLocalIds = false;
      orderedIds.forEach((id, index) => {
        const remoteTask = remoteOnlyWorkspaceTask(id);
        if (!remoteTask) {
          hasLocalIds = true;
          return;
        }
        const ownerTaskId = workspaceTaskOwnerTaskId(remoteTask);
        if (ownerTaskId) remoteOrders.set(ownerTaskId, index);
      });
      await reorderRemoteTaskPins(remoteOrders);
      if (hasLocalIds) {
        // Local pin orders take their index within the full mixed list, so the
        // full ordered id list goes to the server; it ignores ids it does not
        // own, leaving remote entries to the overlay written above.
        await store.reorderPinned(repoId, orderedIds);
      } else if (remoteOrders.size > 0) {
        await refreshAfterRemotePinChange("reorderRemoteTaskPins");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function markRemoteWorkspaceTaskRead(
    workspaceTask: WorkspaceTask,
    expectedActivityRevision: number,
  ): Promise<void> {
    const remoteRef = workspaceTask.terminal.remoteRef;
    if (!remoteRef || workspaceTask.terminal.kind === "none") return;

    let activeClient: ActiveMarkReadClient | null = null;
    try {
      const client = workspaceTask.terminal.kind === "lan"
        ? await createConfiguredDesktopLanTerminalClient()
        : await createConfiguredDesktopRelayTerminalClient();
      if (!client) {
        console.warn("[remote] failed to mark task read: remote task owner is unavailable.");
        return;
      }
      activeClient = { client, closed: false };
      if (desktopCloudWorkspaceDisposed) {
        closeMarkReadClient(activeClient);
        return;
      }
      activeMarkReadClients.add(activeClient);
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          client.markTaskRead({
            desktopId: remoteRef.ownerDesktopId,
            taskId: remoteRef.ownerLocalTaskId,
            expectedActivityRevision,
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("remote mark-read request timed out"));
            }, REMOTE_MARK_READ_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout !== null) clearTimeout(timeout);
      }
    } catch (error) {
      console.warn(
        "[remote] failed to mark task read:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (activeClient) closeMarkReadClient(activeClient);
    }
  }

  function closeMarkReadClient(activeClient: ActiveMarkReadClient): void {
    if (activeClient.closed) return;
    activeClient.closed = true;
    activeMarkReadClients.delete(activeClient);
    try {
      activeClient.client.close();
    } catch (error) {
      console.warn(
        "[remote] failed to close mark-read client:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function disposeDesktopCloudWorkspace(): void {
    desktopCloudWorkspaceDisposed = true;
    remoteStageAdvancesPending.clear();
    for (const activeClient of [...activeMarkReadClients]) {
      closeMarkReadClient(activeClient);
    }
    unsubscribeDesktopAuth?.();
    stopCloudTaskSubscription();
    void transferMachineSync.dispose().catch((error) => {
      console.warn("[cloud] failed to dispose transfer machine sync:", error);
    });
    if (lanRefreshTimer) {
      clearInterval(lanRefreshTimer);
    }
  }

  return {
    desktopAuthSession,
    desktopAuthState,
    cloudSnapshot,
    lanSnapshot,
    transferMachines,
    locallyClosedRemoteTaskIds,
    selectedCloudRepoId,
    selectedCloudItemId,
    localReposForCloudMatching,
    remoteSnapshot,
    workspace,
    remoteTaskDiagnostics,
    workspaceTasksByItemId,
    workspaceBlockers,
    sidebarRepos,
    sidebarItems,
    selectedCloudRepo,
    selectedCloudItem,
    mainPanelRepo,
    mainPanelItem,
    mainPanelIsCloudTask,
    selectedWorkspaceTask,
    selectedRemoteBlockers,
    selectedRemoteTaskIsBlocked,
    mainPanelCloudTerminalRef,
    isCloudOnlyRepoId,
    cloudRepoRemoteUrl,
    markWorkspaceTaskLocallyClosed,
    refreshLanTasks,
    __e2eInjectRemoteSnapshot,
    __e2eFailNextRemoteAction,
    associateDesktopCloudCredential,
    initializeDesktopCloudAuth,
    initializeDesktopLanTaskSync,
    markTransferSidecarReady,
    refreshCloudTransferRoute,
    updateLanTransferPeers,
    closeSelectedWorkspaceTask,
    advanceSelectedRemoteWorkspaceTask,
    pinSidebarTask,
    unpinSidebarTask,
    reorderPinnedSidebarTasks,
    disposeDesktopCloudWorkspace,
  };
}

function parseTransferIdentity(value: unknown): DesktopCloudTransferIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("transfer sidecar returned an invalid local identity");
  }
  const record = value as Record<string, unknown>;
  const peerId = transferIdentityString(record.peer_id ?? record.peerId, "peer id");
  const displayName = transferIdentityString(
    record.display_name ?? record.displayName,
    "display name",
  );
  const publicKey = transferIdentityString(record.public_key ?? record.publicKey, "public key");
  const protocolVersion = record.protocol_version ?? record.protocolVersion;
  const acceptingTransfers = record.accepting_transfers ?? record.acceptingTransfers;
  if (!Number.isSafeInteger(protocolVersion) || (protocolVersion as number) <= 0) {
    throw new Error("transfer sidecar returned an invalid protocol version");
  }
  if (typeof acceptingTransfers !== "boolean") {
    throw new Error("transfer sidecar returned an invalid accepting-transfers flag");
  }
  return {
    peerId,
    displayName,
    publicKey,
    protocolVersion: protocolVersion as number,
    acceptingTransfers,
  };
}

function transferIdentityString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`transfer sidecar returned an invalid ${label}`);
  }
  return value.trim();
}

async function resolveTransferDesktopId(): Promise<string | null> {
  const mobileStatus = await invoke<{ desktopId?: string }>("mobile_server_status").catch(() => null);
  if (mobileStatus?.desktopId?.trim()) return mobileStatus.desktopId.trim();
  const envId = await invoke<unknown>("read_env_var", {
    name: "KANNA_TRANSFER_PEER_ID",
  }).catch(() => "");
  return typeof envId === "string" && envId.trim() ? envId.trim() : null;
}
