import type { PipelineItem } from "../types/kanna";
import type { DesktopCloudTerminalRef } from "../services/desktopCloudTaskIndex";

export function remoteTaskClosureKey(ref: DesktopCloudTerminalRef | undefined | null): string | null {
  if (!ref?.ownerDesktopId || !ref.ownerLocalTaskId) return null;
  return `owner:${ref.ownerDesktopId}:${ref.ownerLocalTaskId}`;
}

export function remoteTaskClosureAliases(
  item: Pick<PipelineItem, "id">,
  ref?: DesktopCloudTerminalRef | null,
): string[] {
  const aliases = new Set<string>([item.id]);
  const key = remoteTaskClosureKey(ref);
  if (key) aliases.add(key);
  return [...aliases];
}

export function remoteTaskIsLocallyClosed(
  item: Pick<PipelineItem, "id">,
  ref: DesktopCloudTerminalRef | undefined,
  closedAliases: ReadonlySet<string>,
): boolean {
  return remoteTaskClosureAliases(item, ref).some((alias) => closedAliases.has(alias));
}
