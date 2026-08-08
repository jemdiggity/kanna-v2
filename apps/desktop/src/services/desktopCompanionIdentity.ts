/** Injective key for a remote owner desktop and its local task id. */
export function desktopCompanionRemoteKey(
  ownerDesktopId: string,
  ownerTaskId: string,
): string {
  return JSON.stringify([ownerDesktopId, ownerTaskId]);
}
