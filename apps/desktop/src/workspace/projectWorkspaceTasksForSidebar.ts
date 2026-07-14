import { taskUiSlotToSidebarItem } from "../stores/taskUiSlots";
import type { SidebarTaskItem, TaskUiSlot } from "../types/taskUi";
import type { WorkspaceTask } from "./types";

export interface ProjectWorkspaceTasksForSidebarInput {
  taskUiSlots: readonly TaskUiSlot[];
  workspaceTasks: readonly WorkspaceTask[];
}

export interface WorkspaceSidebarProjection {
  sidebarItems: SidebarTaskItem[];
  workspaceTasksByItemId: Map<string, WorkspaceTask>;
}

export interface WorkspaceSidebarProjector {
  project(input: ProjectWorkspaceTasksForSidebarInput): WorkspaceSidebarProjection;
}

interface PresentationRecord {
  slotId: string;
  aliases: Set<string>;
}

interface PresentationMemory {
  recordByLogicalKey: Map<string, PresentationRecord>;
  recordByStableAlias: Map<string, PresentationRecord>;
  ambiguousStableAliases: Set<string>;
}

/**
 * Owns the repo-scoped workspace membership admitted at the final sidebar boundary.
 * A projector instance must be shared by all consumers of a projection sequence.
 */
export function createWorkspaceSidebarProjector(): WorkspaceSidebarProjector {
  const admittedLogicalKeysByRepo = new Map<string, Set<string>>();
  const presentationMemory: PresentationMemory = {
    recordByLogicalKey: new Map(),
    recordByStableAlias: new Map(),
    ambiguousStableAliases: new Set(),
  };

  return {
    project(input) {
      updateAdmittedMembership(admittedLogicalKeysByRepo, input);
      return projectWorkspaceTasksForSidebar(
        input,
        admittedLogicalKeysByRepo,
        presentationMemory,
      );
    },
  };
}

function updateAdmittedMembership(
  admittedLogicalKeysByRepo: Map<string, Set<string>>,
  input: ProjectWorkspaceTasksForSidebarInput,
): void {
  const currentKeysByRepo = new Map<string, Set<string>>();
  for (const task of input.workspaceTasks) {
    let keys = currentKeysByRepo.get(task.repoKey);
    if (!keys) {
      keys = new Set<string>();
      currentKeysByRepo.set(task.repoKey, keys);
    }
    keys.add(task.logicalTaskKey);
  }

  const reposWithUnacknowledgedSlots = new Set(
    input.taskUiSlots
      .filter((slot) => slot.state === "creating" && slot.task_id === null)
      .map((slot) => slot.draft.repo_id),
  );
  const repos = new Set([
    ...admittedLogicalKeysByRepo.keys(),
    ...currentKeysByRepo.keys(),
    ...input.taskUiSlots.map((slot) => slot.draft.repo_id),
  ]);

  for (const repoId of repos) {
    if (reposWithUnacknowledgedSlots.has(repoId)) {
      if (!admittedLogicalKeysByRepo.has(repoId)) {
        admittedLogicalKeysByRepo.set(repoId, bootstrapAdmittedLogicalKeys(input, repoId));
      }
      continue;
    }
    admittedLogicalKeysByRepo.set(repoId, new Set(currentKeysByRepo.get(repoId) ?? []));
  }
}

function bootstrapAdmittedLogicalKeys(
  input: ProjectWorkspaceTasksForSidebarInput,
  repoId: string,
): Set<string> {
  const durableSlotTaskIds = new Set(
    input.taskUiSlots
      .filter((slot) => slot.draft.repo_id === repoId && slot.task_id !== null)
      .map((slot) => slot.task_id),
  );
  const admitted = new Set<string>();

  for (const workspaceTask of input.workspaceTasks) {
    if (workspaceTask.repoKey !== repoId) continue;
    const matchesDurableSlot = [...workspaceTaskDurableCandidates(workspaceTask)]
      .some((candidate) => durableSlotTaskIds.has(candidate));
    if (matchesDurableSlot) {
      admitted.add(workspaceTask.logicalTaskKey);
    }
  }

  return admitted;
}

function projectWorkspaceTasksForSidebar(
  input: ProjectWorkspaceTasksForSidebarInput,
  admittedLogicalKeysByRepo: ReadonlyMap<string, ReadonlySet<string>>,
  presentationMemory: PresentationMemory,
): WorkspaceSidebarProjection {
  const sidebarItems: SidebarTaskItem[] = [];
  const workspaceTasksByItemId = new Map<string, WorkspaceTask>();
  const ambiguousWorkspaceTaskAliases = new Set<string>();
  const representedSlotIds = new Set<string>();
  const claimedSlotIds = new Set<string>();
  const claimedPresentationRecords = new Set<PresentationRecord>();
  const slotsByRepo = slotsWithDurableIdentityByRepo(input.taskUiSlots);

  for (const workspaceTask of input.workspaceTasks) {
    const slot = matchingSlot(workspaceTask, slotsByRepo, claimedSlotIds);
    const admitted = admittedLogicalKeysByRepo
      .get(workspaceTask.repoKey)
      ?.has(workspaceTask.logicalTaskKey) ?? false;
    if (!slot && !admitted) continue;

    if (slot) {
      claimedSlotIds.add(slot.slot_id);
      representedSlotIds.add(slot.slot_id);
    }
    const presentationRecord = presentationRecordFor(
      presentationMemory,
      claimedPresentationRecords,
      workspaceTask,
      slot,
    );
    claimedPresentationRecords.add(presentationRecord);
    const sidebarItem = projectWorkspaceTask(workspaceTask, slot, presentationRecord.slotId);
    sidebarItems.push(sidebarItem);
    addWorkspaceTaskAliases(
      workspaceTasksByItemId,
      ambiguousWorkspaceTaskAliases,
      presentationRecord.aliases,
      workspaceTask,
      sidebarItem,
      slot,
    );
  }

  for (const slot of input.taskUiSlots) {
    if (slot.state !== "creating" || representedSlotIds.has(slot.slot_id)) continue;
    sidebarItems.push(taskUiSlotToSidebarItem(slot));
  }

  return { sidebarItems, workspaceTasksByItemId };
}

function presentationRecordFor(
  memory: PresentationMemory,
  claimedRecords: ReadonlySet<PresentationRecord>,
  workspaceTask: WorkspaceTask,
  slot: TaskUiSlot | undefined,
): PresentationRecord {
  const stableAliases = workspaceTaskStableIdentityAliases(workspaceTask);
  let record = memory.recordByLogicalKey.get(workspaceTask.logicalTaskKey);

  if (!record) {
    const candidates = new Set<PresentationRecord>();
    for (const alias of stableAliases) {
      if (memory.ambiguousStableAliases.has(alias)) continue;
      const candidate = memory.recordByStableAlias.get(alias);
      if (candidate) candidates.add(candidate);
    }
    if (candidates.size === 1) {
      const [candidate] = candidates;
      if (!claimedRecords.has(candidate)) record = candidate;
    }
  }

  if (!record || claimedRecords.has(record)) {
    record = {
      slotId: slot?.slot_id
        ?? workspaceTask.localTaskId
        ?? `remote:${workspaceTask.logicalTaskKey}`,
      aliases: new Set(),
    };
  }

  memory.recordByLogicalKey.set(workspaceTask.logicalTaskKey, record);
  registerStableIdentityAliases(memory, record, stableAliases);
  return record;
}

function workspaceTaskStableIdentityAliases(workspaceTask: WorkspaceTask): Set<string> {
  const aliases = new Set<string>();
  addStableTaskId(aliases, workspaceTask.item.id);
  addStableTaskId(aliases, workspaceTask.localTaskId);
  for (const taskId of workspaceTask.remoteTaskIds) addStableTaskId(aliases, taskId);
  for (const source of workspaceTask.sources) {
    addStableTaskId(aliases, source.taskId);
    addStableOwnerIdentity(
      aliases,
      source.terminalRef?.ownerDesktopId,
      source.terminalRef?.ownerLocalTaskId,
    );
  }
  addStableOwnerIdentity(
    aliases,
    workspaceTask.terminal.remoteRef?.ownerDesktopId,
    workspaceTask.terminal.remoteRef?.ownerLocalTaskId,
  );
  return aliases;
}

function registerStableIdentityAliases(
  memory: PresentationMemory,
  record: PresentationRecord,
  stableAliases: ReadonlySet<string>,
): void {
  for (const alias of stableAliases) {
    if (memory.ambiguousStableAliases.has(alias)) continue;
    const existing = memory.recordByStableAlias.get(alias);
    if (existing && existing !== record) {
      memory.recordByStableAlias.delete(alias);
      memory.ambiguousStableAliases.add(alias);
      continue;
    }
    memory.recordByStableAlias.set(alias, record);
  }
}

function addStableTaskId(aliases: Set<string>, taskId: string | null | undefined): void {
  if (taskId) aliases.add(`task:${encodeURIComponent(taskId)}`);
}

function addStableOwnerIdentity(
  aliases: Set<string>,
  desktopId: string | null | undefined,
  taskId: string | null | undefined,
): void {
  if (!desktopId || !taskId) return;
  aliases.add(`owner:${encodeURIComponent(desktopId)}:${encodeURIComponent(taskId)}`);
}

function slotsWithDurableIdentityByRepo(
  slots: readonly TaskUiSlot[],
): Map<string, TaskUiSlot[]> {
  const slotsByRepo = new Map<string, TaskUiSlot[]>();
  for (const slot of slots) {
    if (slot.task_id === null) continue;
    const repoId = slot.draft.repo_id;
    const repoSlots = slotsByRepo.get(repoId) ?? [];
    repoSlots.push(slot);
    slotsByRepo.set(repoId, repoSlots);
  }
  return slotsByRepo;
}

function matchingSlot(
  workspaceTask: WorkspaceTask,
  slotsByRepo: ReadonlyMap<string, readonly TaskUiSlot[]>,
  claimedSlotIds: ReadonlySet<string>,
): TaskUiSlot | undefined {
  const durableCandidates = workspaceTaskDurableCandidates(workspaceTask);
  const matches = (slotsByRepo.get(workspaceTask.repoKey) ?? [])
    .filter((slot) =>
      !claimedSlotIds.has(slot.slot_id)
      && slot.task_id !== null
      && durableCandidates.has(slot.task_id),
    );

  // A noncanonical slot came from an existing creation flow and is the identity
  // that must survive if a canonical snapshot slot was also created transiently.
  return matches.find((slot) => slot.task_id !== slot.slot_id) ?? matches[0];
}

function workspaceTaskDurableCandidates(workspaceTask: WorkspaceTask): Set<string> {
  const candidates = new Set<string>();
  addAlias(candidates, workspaceTask.localTaskId);
  addAlias(candidates, workspaceTask.item.id);
  for (const taskId of workspaceTask.remoteTaskIds) addAlias(candidates, taskId);
  for (const source of workspaceTask.sources) {
    addAlias(candidates, source.taskId);
    addAlias(candidates, source.terminalRef?.ownerLocalTaskId);
  }
  addAlias(candidates, workspaceTask.terminal.remoteRef?.ownerLocalTaskId);
  addAlias(candidates, logicalOwnerTaskId(workspaceTask));
  return candidates;
}

function projectWorkspaceTask(
  workspaceTask: WorkspaceTask,
  slot: TaskUiSlot | undefined,
  presentationSlotId: string,
): SidebarTaskItem {
  const remoteTask = workspaceTask.owner.kind !== "local";
  if (slot?.state === "creating") {
    return {
      ...taskUiSlotToSidebarItem(slot),
      slot_id: presentationSlotId,
      repo_id: workspaceTask.repoKey,
      remote_task: remoteTask,
    };
  }

  const { id: workspacePresentationTaskId, ...presentation } = workspaceTask.item;
  if (slot) {
    return {
      ...presentation,
      slot_id: presentationSlotId,
      task_id: slot.task_id,
      state: "ready",
      repo_id: workspaceTask.repoKey,
      remote_task: remoteTask,
    };
  }

  if (workspaceTask.localTaskId !== null) {
    return {
      ...presentation,
      slot_id: presentationSlotId,
      task_id: workspaceTask.localTaskId,
      state: "ready",
      repo_id: workspaceTask.repoKey,
      remote_task: remoteTask,
    };
  }

  return {
    ...presentation,
    slot_id: presentationSlotId,
    task_id: workspacePresentationTaskId,
    state: "ready",
    repo_id: workspaceTask.repoKey,
    remote_task: remoteTask,
  };
}

function addWorkspaceTaskAliases(
  aliases: Map<string, WorkspaceTask>,
  ambiguousAliases: Set<string>,
  taskAliases: Set<string>,
  workspaceTask: WorkspaceTask,
  sidebarItem: SidebarTaskItem,
  slot: TaskUiSlot | undefined,
): void {
  addAlias(taskAliases, sidebarItem.slot_id);
  addAlias(taskAliases, sidebarItem.task_id);
  addAlias(taskAliases, slot?.slot_id);
  addAlias(taskAliases, slot?.task_id);
  addAlias(taskAliases, workspaceTask.item.id);
  addAlias(taskAliases, workspaceTask.localTaskId);
  for (const taskId of workspaceTask.remoteTaskIds) addAlias(taskAliases, taskId);
  for (const source of workspaceTask.sources) {
    addAlias(taskAliases, source.taskId);
    addAlias(taskAliases, source.terminalRef?.ownerLocalTaskId);
  }
  addAlias(taskAliases, workspaceTask.terminal.remoteRef?.ownerLocalTaskId);
  addAlias(taskAliases, logicalOwnerTaskId(workspaceTask));
  addAlias(taskAliases, workspaceTask.logicalTaskKey);

  for (const alias of taskAliases) {
    if (ambiguousAliases.has(alias)) continue;
    const existing = aliases.get(alias);
    if (existing && existing !== workspaceTask) {
      aliases.delete(alias);
      ambiguousAliases.add(alias);
      continue;
    }
    aliases.set(alias, workspaceTask);
  }
}

function logicalOwnerTaskId(workspaceTask: WorkspaceTask): string | null {
  const marker = ":owner-local:";
  const markerIndex = workspaceTask.logicalTaskKey.indexOf(marker);
  if (markerIndex < 0) return null;
  const ownerTaskId = workspaceTask.logicalTaskKey.slice(markerIndex + marker.length);
  return ownerTaskId || null;
}

function addAlias(aliases: Set<string>, alias: string | null | undefined): void {
  if (alias) aliases.add(alias);
}
