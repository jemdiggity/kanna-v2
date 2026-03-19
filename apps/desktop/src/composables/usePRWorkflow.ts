import { invoke } from "../invoke";
import { GitHubClient, parseGitHubRemote, validatePRCreation, type Stage } from "@kanna/core";
import {
  updatePipelineItemStage,
  updatePipelineItemPR,
  type DbHandle,
  type PipelineItem,
} from "@kanna/db";

async function getGitHubToken(): Promise<string> {
  try {
    const token = await invoke<string>("read_env_var", { name: "KANNA_GITHUB_TOKEN" });
    if (token) return token;
  } catch {}
  throw new Error("KANNA_GITHUB_TOKEN not set");
}

export function usePRWorkflow(db: DbHandle) {
  async function createPR(item: PipelineItem, repoPath: string) {
    // 1. Validate
    validatePRCreation(item.stage as Stage, item.pr_number);

    // 2. Get remote URL and parse owner/repo
    const remoteUrl = await invoke<string>("git_remote_url", { repoPath });
    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) throw new Error("Not a GitHub repository");

    // 3. Get default branch
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath });

    // 4. Push branch
    await invoke("git_push", { repoPath, branch: item.branch! });

    // 5. Get GitHub token and create client
    const token = await getGitHubToken();
    const github = new GitHubClient(remote.owner, remote.repo, token);

    // 6. Create PR
    const title = item.issue_title
      ? `Fix #${item.issue_number}: ${item.issue_title}`
      : item.prompt?.slice(0, 70) || "Kanna task";

    const pr = await github.createPR({
      title,
      body: item.prompt || "",
      head: item.branch!,
      base: defaultBranch,
    });

    // 7. Update DB
    await updatePipelineItemPR(db, item.id, pr.number, pr.html_url);
    await updatePipelineItemStage(db, item.id, "needs_review");
  }

  async function mergePR(item: PipelineItem, repoPath: string) {
    const remoteUrl = await invoke<string>("git_remote_url", { repoPath });
    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) throw new Error("Not a GitHub repository");

    const token = await getGitHubToken();
    const github = new GitHubClient(remote.owner, remote.repo, token);

    await github.mergePR(item.pr_number!);
    await updatePipelineItemStage(db, item.id, "merged");
  }

  return { createPR, mergePR };
}
