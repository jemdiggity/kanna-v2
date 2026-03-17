import type { GitHubIssue, GitHubPR, CreatePRParams } from "./types.js";

const GITHUB_API = "https://api.github.com";

export interface ParsedGitHubRemote {
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub remote URL (SSH or HTTPS) into owner/repo components.
 * Returns null if the URL is not a recognized GitHub remote.
 */
export function parseGitHubRemote(url: string): ParsedGitHubRemote | null {
  // SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\/.*)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

export class GitHubClient {
  private readonly baseHeaders: Record<string, string>;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    token: string
  ) {
    this.baseHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private url(path: string): string {
    return `${GITHUB_API}/repos/${this.owner}/${this.repo}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(this.url(path), {
      method,
      headers: this.baseHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API error ${response.status} ${response.statusText}: ${text}`
      );
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }

  async listIssues(state: "open" | "closed" | "all" = "open"): Promise<GitHubIssue[]> {
    const raw = await this.request<
      Array<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        labels: Array<{ name: string }>;
        html_url: string;
        created_at: string;
        updated_at: string;
        pull_request?: unknown;
      }>
    >("GET", `/issues?state=${state}&per_page=100`);

    // GitHub issues endpoint also returns PRs; filter them out
    return raw
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state as "open" | "closed",
        labels: i.labels.map((l) => l.name),
        html_url: i.html_url,
        created_at: i.created_at,
        updated_at: i.updated_at,
      }));
  }

  async createPR(params: CreatePRParams): Promise<GitHubPR> {
    return this.request<GitHubPR>("POST", "/pulls", {
      title: params.title,
      body: params.body ?? "",
      head: params.head,
      base: params.base,
      draft: params.draft ?? false,
    });
  }

  async mergePR(prNumber: number): Promise<void> {
    await this.request("PUT", `/pulls/${prNumber}/merge`, {
      merge_method: "squash",
    });
  }

  async closePR(prNumber: number): Promise<GitHubPR> {
    return this.request<GitHubPR>("PATCH", `/pulls/${prNumber}`, {
      state: "closed",
    });
  }

  async addLabel(issueOrPrNumber: number, label: string): Promise<void> {
    await this.request("POST", `/issues/${issueOrPrNumber}/labels`, {
      labels: [label],
    });
  }

  async removeLabel(issueOrPrNumber: number, label: string): Promise<void> {
    await this.request(
      "DELETE",
      `/issues/${issueOrPrNumber}/labels/${encodeURIComponent(label)}`
    );
  }

  async postComment(issueOrPrNumber: number, body: string): Promise<void> {
    await this.request("POST", `/issues/${issueOrPrNumber}/comments`, {
      body,
    });
  }
}
