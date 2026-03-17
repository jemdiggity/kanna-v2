export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePRParams {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}
