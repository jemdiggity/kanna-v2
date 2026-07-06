import type { PipelineItem, Repo } from "@kanna/db";
import { invoke } from "../invoke";
import { shellSingleQuote } from "../utils/shell";
import type { StoreContext } from "./state";

function taskIdCandidatesFromWorktreeName(name: string): string[] {
  if (!name.startsWith("task-")) return [];
  const remainder = name.slice("task-".length);
  if (!remainder) return [];
  const candidates = [remainder];
  const lastDash = remainder.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = remainder.slice(lastDash + 1);
    if (/^\d+$/.test(suffix)) {
      candidates.push(remainder.slice(0, lastDash));
    }
  }
  return candidates;
}

async function resolveTaskIdFromWorktreeName(context: StoreContext, name: string): Promise<string | null> {
  for (const candidate of taskIdCandidatesFromWorktreeName(name)) {
    const rows = await context.requireDb().select<{ id: string }>(
      "SELECT id FROM pipeline_item WHERE id = ? LIMIT 1",
      [candidate],
    );
    if (rows.length > 0) return candidate;
  }
  return null;
}

async function collectTaskWorktreeCleanupPaths(
  context: StoreContext,
  item: PipelineItem,
  repo: Repo,
): Promise<string[]> {
  const paths = new Set<string>();
  const rows = await context.requireDb().select<{ path: string }>(
    "SELECT path FROM worktree WHERE pipeline_item_id = ?",
    [item.id],
  );
  rows.forEach((row) => {
    if (row.path) paths.add(row.path);
  });

  const worktreesDir = `${repo.path}/.kanna-worktrees`;
  const names = await invoke<string[]>("list_dir", { path: worktreesDir }).catch(() => []);
  for (const name of names) {
    if (await resolveTaskIdFromWorktreeName(context, name) === item.id) {
      paths.add(`${worktreesDir}/${name}`);
    }
  }

  return [...paths].sort();
}

export async function cleanupClosedTaskWorktrees(
  context: StoreContext,
  item: PipelineItem,
  repo: Repo,
): Promise<void> {
  const paths = await collectTaskWorktreeCleanupPaths(context, item, repo);
  if (paths.length > 0) {
    const quotedPaths = paths.map((path) => shellSingleQuote(path)).join(" ");
    const script = [
      "set -e",
      `repo=${shellSingleQuote(repo.path)}`,
      `for wt in ${quotedPaths}; do`,
      "  if [ -d \"$wt\" ]; then",
      "    if [ -n \"$(git -C \"$wt\" status --porcelain)\" ]; then",
      `      git -C "$wt" add -A && git -C "$wt" commit -m ${shellSingleQuote("WIP at task close")}`,
      "    fi",
      "  fi",
      "  git -C \"$repo\" worktree remove --force --force \"$wt\" || { [ ! -e \"$wt\" ] || rm -rf \"$wt\"; }",
      "done",
      "git -C \"$repo\" worktree prune",
    ].join("\n");
    await invoke("run_script", { script, cwd: repo.path, env: {} });
  } else {
    await invoke("run_script", {
      script: "git worktree prune",
      cwd: repo.path,
      env: {},
    }).catch((error: unknown) => {
      console.debug("[store] git worktree prune skipped during close cleanup:", error);
    });
  }
  await context.requireDb().execute("DELETE FROM worktree WHERE pipeline_item_id = ?", [item.id]);
}
