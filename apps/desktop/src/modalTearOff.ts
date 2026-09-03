import type { PendingReviewComment } from "./utils/reviewComments";

export interface TreeExplorerTearOffContext {
  surface: "tree";
  worktreePath: string;
  repoRoot: string;
  homePath?: string;
  remoteDesktopId?: string;
  remoteTaskId?: string;
}

export interface DiffTearOffContext {
  surface: "diff";
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "working";
  initialScrollPositions?: Partial<Record<"branch" | "working", number>>;
  initialBranchInclude?: "none" | "staged" | "all";
  baseRef?: string;
  viewKey?: string;
  taskId?: string;
  reviewStage?: string;
  reviewComments?: PendingReviewComment[];
  reviewHeadCommit?: string;
  approveSignalsMerge?: boolean;
  hasRunningPost?: boolean;
  remoteDesktopId?: string;
  remoteTaskId?: string;
}

export type ModalTearOffContext = TreeExplorerTearOffContext | DiffTearOffContext;

export interface ModalTearOffGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ModalTearOffDragOrigin {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  modalLeft: number;
  modalTop: number;
  modalWidth: number;
  modalHeight: number;
}

const TEAR_OFF_QUERY_KEY = "tearOff";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isModalTearOffContext(value: unknown): value is ModalTearOffContext {
  if (!isRecord(value)) return false;
  const hasValidRemoteRoute =
    (value.remoteDesktopId === undefined && value.remoteTaskId === undefined)
    || (typeof value.remoteDesktopId === "string" && typeof value.remoteTaskId === "string");
  if (!hasValidRemoteRoute) return false;
  if (value.surface === "tree") {
    return typeof value.worktreePath === "string" && typeof value.repoRoot === "string";
  }
  return value.surface === "diff" && typeof value.repoPath === "string";
}

export function buildModalTearOffUrl(context: ModalTearOffContext): string {
  const params = new URLSearchParams();
  params.set(TEAR_OFF_QUERY_KEY, JSON.stringify(context));
  return `/?${params.toString()}`;
}

export function parseModalTearOffContext(search: string): ModalTearOffContext | null {
  const serialized = new URLSearchParams(search).get(TEAR_OFF_QUERY_KEY);
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isModalTearOffContext(parsed) ? parsed : null;
  } catch (error) {
    console.warn("[modalTearOff] failed to parse window context:", error);
    return null;
  }
}

export function resolveModalTearOffGeometry(
  origin: ModalTearOffDragOrigin,
  release: Pick<PointerEvent, "clientX" | "clientY" | "screenX" | "screenY">,
): ModalTearOffGeometry {
  const grabOffsetX = origin.clientX - origin.modalLeft;
  const grabOffsetY = origin.clientY - origin.modalTop;
  return {
    x: Math.round(release.screenX - grabOffsetX),
    y: Math.round(release.screenY - grabOffsetY),
    width: Math.round(origin.modalWidth),
    height: Math.round(origin.modalHeight),
  };
}

export function modalTearOffTitle(context: ModalTearOffContext): string {
  if (context.surface === "diff") return "Diff — Kanna";
  const segments = context.worktreePath.split("/").filter(Boolean);
  return `${segments.at(-1) ?? "Files"} — Kanna`;
}
