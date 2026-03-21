import { ref, type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import type { Repo } from "@kanna/db";
import { listRepos, insertRepo, hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery, findRepoByPath } from "@kanna/db";

export function useRepo(db: Ref<DbHandle | null>) {
  const repos = ref<Repo[]>([]);
  const selectedRepoId = ref<string | null>(null);

  async function refresh() {
    if (!db.value) return;
    repos.value = await listRepos(db.value);
  }

  async function importRepo(path: string, name: string, defaultBranch: string) {
    if (!db.value) return;
    const existing = await findRepoByPath(db.value, path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(db.value, existing.id);
        await refresh();
        selectedRepoId.value = existing.id;
      }
      return;
    }
    const id = crypto.randomUUID();
    await insertRepo(db.value, { id, path, name, default_branch: defaultBranch });
    await refresh();
    selectedRepoId.value = id;
  }

  async function hideRepo(id: string) {
    if (!db.value) return;
    await hideRepoQuery(db.value, id);
    if (selectedRepoId.value === id) {
      selectedRepoId.value = null;
    }
    await refresh();
  }

  async function unhideRepo(id: string) {
    if (!db.value) return;
    await unhideRepoQuery(db.value, id);
    await refresh();
  }

  return {
    repos,
    selectedRepoId,
    refresh,
    importRepo,
    hideRepo,
    unhideRepo,
  };
}
