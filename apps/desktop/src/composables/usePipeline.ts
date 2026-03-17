import { ref, type Ref } from "vue";
import { invoke } from "../invoke";
import type { DbHandle } from "@kanna/db";
import type { PipelineItem } from "@kanna/db";
import { listPipelineItems, updatePipelineItemStage, insertPipelineItem } from "@kanna/db";
import { canTransition, type Stage } from "@kanna/core";

export function usePipeline(db: Ref<DbHandle | null>) {
  const items = ref<PipelineItem[]>([]);
  const selectedItemId = ref<string | null>(null);

  async function loadItems(repoId: string) {
    if (!db.value) return;
    items.value = await listPipelineItems(db.value, repoId);
  }

  async function transition(itemId: string, toStage: Stage) {
    if (!db.value) return;
    const item = items.value.find((i) => i.id === itemId);
    if (!item) return;
    if (!canTransition(item.stage as Stage, toStage)) return;
    await updatePipelineItemStage(db.value, itemId, toStage);
    // Refresh the item in the list
    item.stage = toStage;
  }

  async function createItem(repoId: string, repoPath: string, prompt: string) {
    if (!db.value) return;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;

    // 1. Create git worktree
    await invoke("git_worktree_add", {
      repoPath,
      branch,
      path: worktreePath,
    });

    // 2. Insert pipeline item to DB
    await insertPipelineItem(db.value, {
      id,
      repo_id: repoId,
      issue_number: null,
      issue_title: null,
      prompt,
      stage: "in_progress",
      pr_number: null,
      pr_url: null,
      branch,
      agent_type: null,
    });

    // 3. Spawn Claude agent session
    await invoke("create_agent_session", {
      sessionId: id,
      cwd: worktreePath,
      prompt,
      systemPrompt: null,
    });

    // 4. Refresh pipeline items and select the new one
    await loadItems(repoId);
    selectedItemId.value = id;
  }

  function selectedItem(): PipelineItem | null {
    if (!selectedItemId.value) return null;
    return items.value.find((i) => i.id === selectedItemId.value) ?? null;
  }

  return {
    items,
    selectedItemId,
    loadItems,
    transition,
    createItem,
    selectedItem,
  };
}
