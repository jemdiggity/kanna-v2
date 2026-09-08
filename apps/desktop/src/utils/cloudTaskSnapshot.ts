import type { PipelineItem, Repo } from "../types/kanna";
import { directorySingletonAgent } from "./singletonTask";

export interface CloudTaskSnapshotInput {
  desktopId: string;
  item: Pick<
    PipelineItem,
    | "id"
    | "repo_id"
    | "prompt"
    | "pipeline"
    | "singleton_agent"
    | "stage"
    | "activity"
    | "activity_revision"
    | "runtime_state"
    | "read_state"
    | "blocker_revision"
    | "transition_revision"
    | "branch"
    | "base_ref"
    | "pr_number"
    | "pr_url"
    | "display_name"
    | "has_running_post"
    | "last_output_preview"
    | "agent_provider"
    | "agent_type"
    | "parent_task_id"
    | "created_at"
    | "updated_at"
    | "closed_at"
  >;
  repo: Pick<Repo, "id" | "name" | "path" | "default_branch"> & {
    remote_url?: string | null;
  };
  blockedByTaskIds: string[];
}

export async function buildCloudTaskSnapshot(input: CloudTaskSnapshotInput) {
  const prompt = input.item.prompt ?? "";
  const title = input.item.display_name || prompt.split("\n")[0]?.trim() || input.item.id;
  return {
    localRepoId: input.repo.id,
    ownerDesktopId: input.desktopId,
    ownerLocalTaskId: input.item.id,
    // Republished so a peer reading this snapshot can pin the account-wide
    // singleton by default without asking the relay directory.
    singletonAgent: directorySingletonAgent(input.item),
    title,
    promptSnippet: prompt ? prompt.slice(0, 500) : null,
    waitingPromptSnippet: input.item.last_output_preview?.trim() || null,
    displayName: input.item.display_name,
    stage: input.item.stage,
    activity: input.item.activity,
    activityRevision: input.item.activity_revision,
    runtimeState: input.item.runtime_state,
    readState: input.item.read_state,
    blockerRevision: input.item.blocker_revision,
    transitionRevision: input.item.transition_revision,
    status: deriveStatus(input.item.stage, input.item.closed_at, input.blockedByTaskIds),
    hasRunningPost: Boolean(input.item.has_running_post),
    repo: {
      cloudRepoId: input.repo.id,
      name: input.repo.name,
      remoteUrl: input.repo.remote_url ?? null,
      remoteUrlHash: await hashRemoteUrl(input.repo.remote_url ?? null),
      defaultBranch: input.repo.default_branch,
    },
    branch: input.item.branch,
    baseRef: input.item.base_ref,
    prNumber: input.item.pr_number,
    prUrl: input.item.pr_url,
    agent: {
      provider: input.item.agent_provider,
      type: input.item.agent_type ?? "pty",
    },
    transfer: {
      state: "none" as const,
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: input.blockedByTaskIds,
    parentTaskId: input.item.parent_task_id ?? null,
    createdAt: input.item.created_at,
    updatedAt: input.item.updated_at,
    closedAt: input.item.closed_at,
  };
}

export async function hashRemoteUrl(remoteUrl: string | null): Promise<string | null> {
  if (!remoteUrl) return null;
  const data = new TextEncoder().encode(remoteUrl.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function deriveStatus(
  stage: string,
  closedAt: string | null,
  blockedByTaskIds: string[],
): "active" | "blocked" | "pr" | "done" {
  if (closedAt) return "done";
  if (blockedByTaskIds.length > 0) return "blocked";
  if (stage === "pr") return "pr";
  return "active";
}
