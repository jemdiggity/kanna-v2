import type { TaskSummary } from "../lib/api/types";
import { sameTaskDesktop, taskLocalId } from "../lib/api/taskIdentity";
import { isPinnedTask } from "./taskPinOrder";
import type { ReadyTaskUiSlot, TaskUiSlot } from "../state/taskUiSlots";

/**
 * A task slot paired with its nesting depth (0 = top-level task, 1 = subtask,
 * ...). Mirrors the desktop sidebar's parent/child rows: a task nests under
 * its parent only while that parent is visible in the same list, and any row
 * an invalid parent graph would hide stays visible at the top level.
 */
export interface TaskTreeRow {
  slot: TaskUiSlot;
  depth: number;
}

const sqliteTimestampPattern =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function taskCreationTimestamp(task: TaskSummary): number | null {
  const value = task.createdAt?.trim();
  if (!value) return null;
  const normalized = sqliteTimestampPattern.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function slotLocalTaskId(slot: TaskUiSlot): string | null {
  if (slot.state !== "ready") return null;
  return taskLocalId(slot.task);
}

function compareCreatedAtAscending(left: TaskSummary, right: TaskSummary): number {
  const leftTimestamp = taskCreationTimestamp(left);
  const rightTimestamp = taskCreationTimestamp(right);
  if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
  if (rightTimestamp === null) return -1;
  return leftTimestamp - rightTimestamp;
}

/**
 * Orders slots so each subtask renders directly under its parent,
 * depth-annotated for indented rendering. Top-level rows keep the input
 * order; children sort oldest-first under their parent (desktop parity).
 *
 * A pinned task is never nested: pinning is an explicit request to lift a row
 * to the top of the list, which nesting under a parent would silently defeat.
 * The desktop sidebar does the same — its pinned zone is a flat list above
 * every stage group.
 */
export function buildTaskTreeRows(
  slots: readonly TaskUiSlot[]
): TaskTreeRow[] {
  // Owner-local ids are only unique per desktop, so a mixed collection can
  // hold the same local id from several desktops. Keep every candidate and
  // pick the compatible one per child below.
  const slotsByLocalTaskId = new Map<string, ReadyTaskUiSlot[]>();
  for (const slot of slots) {
    const localTaskId = slotLocalTaskId(slot);
    if (localTaskId === null || slot.state !== "ready") continue;
    const candidates = slotsByLocalTaskId.get(localTaskId) ?? [];
    candidates.push(slot);
    slotsByLocalTaskId.set(localTaskId, candidates);
  }

  const resolveParent = (slot: TaskUiSlot): TaskUiSlot | null => {
    if (slot.state !== "ready") return null;
    if (isPinnedTask(slot.task)) return null;
    const parentTaskId = slot.task.parentTaskId;
    if (!parentTaskId || parentTaskId === slotLocalTaskId(slot)) return null;
    const candidates = (slotsByLocalTaskId.get(parentTaskId) ?? []).filter(
      (parent) =>
        parent.slotId !== slot.slotId &&
        parent.task.repoId === slot.task.repoId &&
        sameTaskDesktop(parent.task, slot.task)
    );
    // An exact desktop match beats an undefined-owner wildcard candidate.
    return (
      candidates.find(
        (parent) =>
          parent.task.ownerDesktopId !== undefined &&
          parent.task.ownerDesktopId === slot.task.ownerDesktopId
      ) ??
      candidates[0] ??
      null
    );
  };

  const childrenByParentSlotId = new Map<string, ReadyTaskUiSlot[]>();
  for (const slot of slots) {
    if (slot.state !== "ready") continue;
    const parent = resolveParent(slot);
    if (!parent) continue;
    const children = childrenByParentSlotId.get(parent.slotId) ?? [];
    children.push(slot);
    childrenByParentSlotId.set(parent.slotId, children);
  }
  for (const children of childrenByParentSlotId.values()) {
    children.sort((left, right) =>
      compareCreatedAtAscending(left.task, right.task)
    );
  }

  const rows: TaskTreeRow[] = [];
  const seenSlotIds = new Set<string>();
  const walk = (slot: TaskUiSlot, depth: number) => {
    if (seenSlotIds.has(slot.slotId)) return;
    seenSlotIds.add(slot.slotId);
    rows.push({ slot, depth });
    for (const child of childrenByParentSlotId.get(slot.slotId) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const slot of slots) {
    if (resolveParent(slot)) continue;
    walk(slot, 0);
  }

  // Safety net for pathological parent cycles: keep every row visible.
  for (const slot of slots) {
    if (seenSlotIds.has(slot.slotId)) continue;
    seenSlotIds.add(slot.slotId);
    rows.push({ slot, depth: 0 });
  }
  return rows;
}
