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
 * persists in the local settings table as a JSON object keyed by the
 * owner-side durable task id. The snapshot already delivers settings to the
 * frontend, so the overlay round-trips through the normal reload path.
 *
 * An entry is either an explicit pin order or `null`, which records an
 * explicit unpin. The two are not the same as absence: a directory singleton
 * is pinned by default, so "no entry" means the default applies while `null`
 * means the operator turned it off and it must stay off across restarts and
 * republications.
 */
export const REMOTE_TASK_PINS_SETTING = "remoteTaskPins";

/** An explicit pin order, or `null` for an explicit unpin. */
export type RemoteTaskPin = number | null;

export function parseRemoteTaskPins(
  settings: Record<string, string> | null | undefined,
): Map<string, RemoteTaskPin> {
  return parseRemoteTaskPinsValue(settings?.[REMOTE_TASK_PINS_SETTING] ?? null);
}

function parseRemoteTaskPinsValue(raw: string | null): Map<string, RemoteTaskPin> {
  const pins = new Map<string, RemoteTaskPin>();
  if (!raw) return pins;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [ownerTaskId, order] of Object.entries(parsed)) {
        if (order === null) {
          pins.set(ownerTaskId, null);
        } else if (typeof order === "number" && Number.isFinite(order)) {
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

function mutateRemoteTaskPins(mutate: (pins: Map<string, RemoteTaskPin>) => void): Promise<void> {
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

/**
 * Unpins a remote row. `defaultPinned` says whether this machine would pin the
 * row on its own — a directory singleton does — in which case the unpin is
 * recorded rather than forgotten, so the default does not put the row straight
 * back at the next snapshot.
 */
export function unpinRemoteTask(
  ownerTaskId: string,
  options: { defaultPinned?: boolean } = {},
): Promise<void> {
  return mutateRemoteTaskPins((pins) => {
    if (options.defaultPinned) {
      pins.set(ownerTaskId, null);
      return;
    }
    pins.delete(ownerTaskId);
  });
}

/**
 * Drops the overlay entry entirely. For a task that is gone — closed, or no
 * longer advertised — there is no default left to suppress, so keeping a
 * sticky unpin would only leak rows into the setting forever.
 */
export function forgetRemoteTaskPin(ownerTaskId: string): Promise<void> {
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
