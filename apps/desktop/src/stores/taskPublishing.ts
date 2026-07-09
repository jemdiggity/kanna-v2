import type { PipelineItem, Repo } from "../types/kanna";
import {
  deleteDesktopTaskSnapshotForLocalTask,
  publishDesktopTaskSnapshot,
} from "../services/desktopCloudPublisher";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { fetchDesktopSnapshot } from "../services/desktopServerClient";
import type { StoreContext } from "./state";

export async function publishTaskSnapshotBestEffort(context: StoreContext, itemId: string, repo: Repo): Promise<void> {
  const snapshot = await fetchDesktopSnapshot();
  const refreshedItem = snapshot.entries
    .flatMap((entry) => entry.items)
    .find((candidate): candidate is PipelineItem => candidate.id === itemId);

  const cloudPublish = refreshedItem
    ? publishDesktopTaskSnapshot(null, refreshedItem, repo)
    : deleteDesktopTaskSnapshotForLocalTask(repo.id, itemId);

  await cloudPublish.catch((error) => {
    console.warn("[cloud] failed to publish task snapshot:", error);
    showCloudPublishErrorToast(context, error);
  });
  void publishDesktopLanTaskSnapshot();
}

export function showCloudPublishErrorToast(context: StoreContext, error: unknown) {
  context.toast.error(`Cloud publish failed: ${cloudPublishErrorLabel(error)}`);
}

function cloudPublishErrorLabel(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error);
}
