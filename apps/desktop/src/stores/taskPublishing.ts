import type { PipelineItem, Repo } from "@kanna/db";
import { publishDesktopTaskSnapshot } from "../services/desktopCloudPublisher";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import type { StoreContext } from "./state";

export async function publishTaskSnapshotBestEffort(context: StoreContext, itemId: string, repo: Repo): Promise<void> {
  const rows = await context.requireDb().select<PipelineItem>(
    "SELECT * FROM pipeline_item WHERE id = ?",
    [itemId],
  );
  const refreshedItem = rows[0];
  if (!refreshedItem) return;

  await publishDesktopTaskSnapshot(context.requireDb(), refreshedItem, repo).catch((error) => {
    console.warn("[cloud] failed to publish task snapshot:", error);
    showCloudPublishErrorToast(context, error);
  });
  void publishDesktopLanTaskSnapshot(context.requireDb());
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
