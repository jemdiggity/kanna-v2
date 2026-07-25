import {
  deleteDesktopSetting,
  getDesktopSetting,
  putDesktopSetting,
} from "./desktopServerClient";

/**
 * Viewer-local pin overlay for remote tasks.
 *
 * Pinning is a per-operator sidebar preference, so pinning a task owned by
 * another desktop must not mutate the owner's state. Remote-only tasks have no
 * local `pipeline_item` row to carry `pinned`/`pin_order`, so their pin state
 * persists in the local settings table as a JSON object mapping the owner-side
 * durable task id to its pin order. The snapshot already delivers settings to
 * the frontend, so the overlay round-trips through the normal reload path.
 */
export const REMOTE_TASK_PINS_SETTING = "remoteTaskPins";

export function parseRemoteTaskPins(
  settings: Record<string, string> | null | undefined,
): Map<string, number> {
  return parseRemoteTaskPinsValue(settings?.[REMOTE_TASK_PINS_SETTING] ?? null);
}

function parseRemoteTaskPinsValue(raw: string | null): Map<string, number> {
  const pins = new Map<string, number>();
  if (!raw) return pins;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [ownerTaskId, order] of Object.entries(parsed)) {
        if (typeof order === "number" && Number.isFinite(order)) {
          pins.set(ownerTaskId, order);
        }
      }
    }
  } catch (error) {
    console.warn("[remote-pins] ignoring malformed remoteTaskPins setting:", error);
  }
  return pins;
}

// Pin and reorder writes for one gesture arrive in the same tick, so
// read-modify-write cycles against the settings key must serialize or a
// slower read could clobber the faster write.
let pendingMutation: Promise<void> = Promise.resolve();

function mutateRemoteTaskPins(mutate: (pins: Map<string, number>) => void): Promise<void> {
  const run = pendingMutation.then(async () => {
    const pins = parseRemoteTaskPinsValue(await getDesktopSetting(REMOTE_TASK_PINS_SETTING));
    mutate(pins);
    if (pins.size === 0) {
      await deleteDesktopSetting(REMOTE_TASK_PINS_SETTING);
      return;
    }
    await putDesktopSetting(REMOTE_TASK_PINS_SETTING, JSON.stringify(Object.fromEntries(pins)));
  });
  // Keep the queue alive after a failure; the failed caller still observes
  // the rejection through `run`.
  pendingMutation = run.catch(() => {});
  return run;
}

export function pinRemoteTask(ownerTaskId: string, position: number): Promise<void> {
  return mutateRemoteTaskPins((pins) => {
    pins.set(ownerTaskId, position);
  });
}

export function unpinRemoteTask(ownerTaskId: string): Promise<void> {
  return mutateRemoteTaskPins((pins) => {
    pins.delete(ownerTaskId);
  });
}

export function reorderRemoteTaskPins(orders: ReadonlyMap<string, number>): Promise<void> {
  if (orders.size === 0) return Promise.resolve();
  return mutateRemoteTaskPins((pins) => {
    for (const [ownerTaskId, order] of orders) {
      pins.set(ownerTaskId, order);
    }
  });
}
