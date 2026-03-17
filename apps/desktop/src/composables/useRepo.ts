import { ref, type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import type { Repo } from "@kanna/db";
import { listRepos, insertRepo, deleteRepo } from "@kanna/db";

export function useRepo(db: Ref<DbHandle | null>) {
  const repos = ref<Repo[]>([]);
  const selectedRepoId = ref<string | null>(null);

  async function refresh() {
    if (!db.value) return;
    repos.value = await listRepos(db.value);
  }

  async function importRepo(path: string, name: string, defaultBranch: string) {
    if (!db.value) return;
    const id = crypto.randomUUID();
    await insertRepo(db.value, { id, path, name, default_branch: defaultBranch });
    await refresh();
    selectedRepoId.value = id;
  }

  async function removeRepo(id: string) {
    if (!db.value) return;
    await deleteRepo(db.value, id);
    if (selectedRepoId.value === id) {
      selectedRepoId.value = null;
    }
    await refresh();
  }

  return {
    repos,
    selectedRepoId,
    refresh,
    importRepo,
    removeRepo,
  };
}
