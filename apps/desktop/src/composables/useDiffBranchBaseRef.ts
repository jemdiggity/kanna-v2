import type { Ref } from "vue";
import { invoke } from "../invoke";

interface ResolvedBranchBaseRef {
  ref: string;
  source: "upstream" | "prop" | "detected";
}

export function useDiffBranchBaseRef(baseRef: Readonly<Ref<string | undefined>>) {
  async function resolveBranchBaseRef(path: string): Promise<ResolvedBranchBaseRef> {
    const upstream = await invoke<string | null>("git_branch_upstream", { repoPath: path })
      .catch((e: unknown) => {
        console.warn("[DiffView] branch upstream unavailable, using stored base ref:", e);
        return null;
      });
    if (upstream) {
      return { ref: upstream, source: "upstream" };
    }
    if (baseRef.value) {
      return { ref: baseRef.value, source: "prop" };
    }
    return { ref: await detectBaseRef(path), source: "detected" };
  }

  async function detectBaseRef(path: string): Promise<string> {
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path });
    try {
      await invoke<string>("git_merge_base", {
        repoPath: path,
        refA: `origin/${defaultBranch}`,
        refB: "HEAD",
      });
      return `origin/${defaultBranch}`;
    } catch (e: unknown) {
      console.warn("[DiffView] origin ref not available, using local:", e);
      return defaultBranch;
    }
  }

  return {
    resolveBranchBaseRef,
  };
}
