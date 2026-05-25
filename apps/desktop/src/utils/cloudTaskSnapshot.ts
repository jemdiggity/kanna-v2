import type { PipelineItem, Repo } from "@kanna/db";

export interface CloudTaskSnapshotInput {
  desktopId: string;
  item: Pick<
    PipelineItem,
    | "id"
    | "repo_id"
    | "prompt"
    | "stage"
    | "activity"
    | "branch"
    | "base_ref"
    | "pr_number"
    | "pr_url"
    | "display_name"
    | "agent_provider"
    | "agent_type"
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
    cloudTaskId: `${input.repo.id}:${input.item.id}`,
    ownerDesktopId: input.desktopId,
    ownerLocalTaskId: input.item.id,
    title,
    promptSnippet: prompt ? prompt.slice(0, 500) : null,
    displayName: input.item.display_name,
    stage: input.item.stage,
    activity: input.item.activity,
    status: deriveStatus(input.item.stage, input.item.closed_at, input.blockedByTaskIds),
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
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: input.blockedByTaskIds,
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
): "active" | "blocked" | "pr" | "merge" | "done" {
  if (closedAt) return "done";
  if (blockedByTaskIds.length > 0) return "blocked";
  if (stage === "pr") return "pr";
  if (stage === "merge") return "merge";
  return "active";
}
