import { ref, shallowRef, watch, type Ref, computed } from "vue";
import { computedAsync, refDebounced } from "@vueuse/core";
import { invoke } from "../invoke";

export interface TreeNode {
  name: string;
  isDir: boolean;
  path: string;
}

interface DirEntryResponse {
  name: string;
  is_dir: boolean;
  path?: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type RemoteDirectoryLoader = (
  path: string,
  showAllFiles: boolean,
) => Promise<{ entries: RemoteDirectoryEntry[] }>;

export interface MillerState {
  columns: TreeNode[][];
  cursor: number[];
  activeColumn: number;
  breadcrumb: string[];
}

export function useTreeExplorer(
  rootPath: Ref<string>,
  repoRoot: Ref<string>,
  remoteDirectoryLoader: Ref<RemoteDirectoryLoader | undefined>,
) {
  const cache = new Map<string, TreeNode[]>();
  const effectiveRoot = computed(() => rootPath.value);

  // ── User-driven state ──────────────────────────────────────────
  const breadcrumb = ref<string[]>([]);
  // Number = direct index, string = find entry by name (for cursor restore after navigateLeft)
  const requestedCursor = ref<number | string>(0);
  const filterText = ref("");
  const filtering = ref(false);
  const error = ref<string | null>(null);
  const slideDirection = shallowRef<"left" | "right" | null>(null);
  const pendingG = ref(false);
  const showAllFiles = ref(false);
  let pendingGTimer: ReturnType<typeof setTimeout> | null = null;
  let slideTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Derived paths ──────────────────────────────────────────────
  const currentDirAbs = computed(() => {
    const root = effectiveRoot.value;
    const bc = breadcrumb.value;
    if (remoteDirectoryLoader.value) return bc.join("/");
    return bc.length === 0 ? root : `${root}/${bc.join("/")}`;
  });

  const parentDirAbs = computed(() => {
    const bc = breadcrumb.value;
    if (bc.length === 0) return null;
    const root = effectiveRoot.value;
    const parentBc = bc.slice(0, -1);
    if (remoteDirectoryLoader.value) return parentBc.join("/");
    return parentBc.length === 0 ? root : `${root}/${parentBc.join("/")}`;
  });

  // ── Fetcher ────────────────────────────────────────────────────
  async function fetchDir(dirPath: string, showAll = false): Promise<TreeNode[]> {
    const cacheKey = `${showAll ? "all" : "visible"}:${dirPath}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    const loader = remoteDirectoryLoader.value;
    const entries: DirEntryResponse[] = loader
      ? (await loader(dirPath, showAll)).entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        is_dir: entry.isDir,
      }))
      : await invoke<DirEntryResponse[]>("read_dir_entries", {
        path: dirPath,
        repoRoot: repoRoot.value,
        showAllFiles: showAll,
      });

    const root = effectiveRoot.value;
    const nodes: TreeNode[] = entries.map((e) => {
      const rel = loader && e.path
        ? e.path
        : dirPath === root
          ? e.name
          : dirPath.slice(root.length + 1) + "/" + e.name;
      return { name: e.name, isDir: e.is_dir, path: rel };
    });

    cache.set(cacheKey, nodes);
    return nodes;
  }

  function absolutePath(relativePath: string): string {
    if (remoteDirectoryLoader.value) return relativePath;
    return relativePath ? `${effectiveRoot.value}/${relativePath}` : effectiveRoot.value;
  }

  // ── Reactive columns ───────────────────────────────────────────
  const loading = ref(false);

  const currentEntries = computedAsync(
    async () => {
      const dir = currentDirAbs.value;
      if (!dir && !remoteDirectoryLoader.value) return [];
      try {
        const includeIgnored = showAllFiles.value;
        const entries = await fetchDir(dir, includeIgnored);
        error.value = null;
        return entries;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error.value = `Task files unavailable: ${msg}`;
        console.error("[tree-explorer] fetch failed:", msg);
        return [];
      }
    },
    [],
    loading,
  );

  const parentEntries = computedAsync(
    async () => {
      const dir = parentDirAbs.value;
      if (!dir) return [];
      try {
        const includeIgnored = showAllFiles.value;
        return await fetchDir(dir, includeIgnored);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[tree-explorer] failed to load parent entries:", message);
        return [];
      }
    },
    [],
  );

  // Resolve requestedCursor against loaded entries
  const cursorIndex = computed(() => {
    const req = requestedCursor.value;
    const entries = currentEntries.value;
    if (typeof req === "string") {
      const idx = entries.findIndex((e) => e.name === req);
      return idx >= 0 ? idx : 0;
    }
    return Math.min(req, Math.max(0, entries.length - 1));
  });

  const selectedEntry = computed(() => currentEntries.value[cursorIndex.value] ?? null);

  // Debounce cursor for preview so rapid j/k doesn't spam fetches
  const debouncedCursor = refDebounced(cursorIndex, 50);
  const previewEntry = computed(() => currentEntries.value[debouncedCursor.value] ?? null);

  const previewEntries = computedAsync(
    async () => {
      const entry = previewEntry.value;
      if (!entry?.isDir) return [];
      try {
        const includeIgnored = showAllFiles.value;
        return await fetchDir(absolutePath(entry.path), includeIgnored);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        error.value = `Task files unavailable: ${message}`;
        console.error("[tree-explorer] failed to load preview entries:", message);
        return [];
      }
    },
    [],
  );

  // ── Derived cursors ────────────────────────────────────────────
  const parentCursor = computed(() => {
    const bc = breadcrumb.value;
    if (bc.length === 0) return 0;
    const idx = parentEntries.value.findIndex((e) => e.name === bc[bc.length - 1]);
    return idx >= 0 ? idx : 0;
  });

  // ── Assembled state (for template) ─────────────────────────────
  const state = computed<MillerState>(() => ({
    columns: [parentEntries.value, currentEntries.value, previewEntries.value],
    cursor: [parentCursor.value, cursorIndex.value, 0],
    activeColumn: 1,
    breadcrumb: breadcrumb.value,
  }));

  // ── Reset on root change ───────────────────────────────────────
  watch([rootPath, remoteDirectoryLoader], () => {
    breadcrumb.value = [];
    showAllFiles.value = false;
    requestedCursor.value = 0;
    filterText.value = "";
    filtering.value = false;
    error.value = null;
    cache.clear();
  });

  // ── Navigation ─────────────────────────────────────────────────
  function clearSlideTimer() {
    if (slideTimer !== null) {
      clearTimeout(slideTimer);
      slideTimer = null;
    }
  }

  function triggerSlide(dir: "left" | "right") {
    slideDirection.value = dir;
    clearSlideTimer();
    slideTimer = setTimeout(() => { slideDirection.value = null; }, 200);
  }

  function navigateRight(): string | null {
    const entry = selectedEntry.value;
    if (!entry) return null;
    if (!entry.isDir) return entry.path;

    triggerSlide("left");
    breadcrumb.value = [...breadcrumb.value, entry.name];
    requestedCursor.value = 0;
    filterText.value = "";
    return null;
  }

  function activateCurrentEntry(index: number): string | null {
    const entry = currentEntries.value[index];
    if (!entry) return null;

    requestedCursor.value = index;
    filterText.value = "";

    if (!entry.isDir) return entry.path;

    triggerSlide("left");
    breadcrumb.value = [...breadcrumb.value, entry.name];
    requestedCursor.value = 0;
    return null;
  }

  function activateParentEntry(index: number): string | null {
    const entry = parentEntries.value[index];
    if (!entry) return null;

    filterText.value = "";

    if (!entry.isDir) return entry.path;

    const parentBreadcrumb = breadcrumb.value.slice(0, -1);
    triggerSlide("right");
    breadcrumb.value = [...parentBreadcrumb, entry.name];
    requestedCursor.value = 0;
    return null;
  }

  function activatePreviewEntry(index: number): string | null {
    const parentEntry = previewEntry.value;
    const entry = previewEntries.value[index];
    if (!parentEntry?.isDir || !entry) return null;

    filterText.value = "";

    if (!entry.isDir) return entry.path;

    triggerSlide("left");
    breadcrumb.value = [...breadcrumb.value, parentEntry.name, entry.name];
    requestedCursor.value = 0;
    return null;
  }

  function navigateLeft() {
    if (breadcrumb.value.length === 0) return;

    triggerSlide("right");
    requestedCursor.value = breadcrumb.value[breadcrumb.value.length - 1];
    breadcrumb.value = breadcrumb.value.slice(0, -1);
    filterText.value = "";
  }

  function activateSelectedEntry(): string | null {
    return activateCurrentEntry(cursorIndex.value);
  }

  function exitCurrentDirectory() {
    navigateLeft();
  }

  // ── Filter / cursor helpers ────────────────────────────────────
  function isVisible(entry: TreeNode): boolean {
    if (!filterText.value) return true;
    return entry.name.toLowerCase().includes(filterText.value.toLowerCase());
  }

  function snapCursorToFirstVisible() {
    const col = currentEntries.value;
    if (!col?.length) return;
    const idx = col.findIndex((e) => isVisible(e));
    if (idx >= 0) requestedCursor.value = idx;
  }

  function moveCursor(delta: number) {
    const col = currentEntries.value;
    if (!col?.length) return;

    const current = cursorIndex.value;
    let next = current;

    if (filterText.value) {
      const step = delta > 0 ? 1 : -1;
      let candidate = current + step;
      while (candidate >= 0 && candidate < col.length) {
        if (isVisible(col[candidate])) {
          next = candidate;
          break;
        }
        candidate += step;
      }
    } else {
      next = Math.max(0, Math.min(col.length - 1, current + delta));
    }

    requestedCursor.value = next;
  }

  function jumpTop() {
    const col = currentEntries.value;
    if (!col?.length) return;
    const idx = filterText.value ? col.findIndex((e) => isVisible(e)) : 0;
    if (idx >= 0) requestedCursor.value = idx;
  }

  function jumpBottom() {
    const col = currentEntries.value;
    if (!col?.length) return;
    let idx = col.length - 1;
    if (filterText.value) {
      for (let i = col.length - 1; i >= 0; i--) {
        if (isVisible(col[i])) { idx = i; break; }
      }
    }
    requestedCursor.value = idx;
  }

  function jumpToBreadcrumb(index: number) {
    breadcrumb.value = breadcrumb.value.slice(0, index);
    requestedCursor.value = 0;
  }

  const currentFilePath = computed(() => selectedEntry.value?.path ?? null);

  // ── Keyboard handler ───────────────────────────────────────────
  function handleKey(e: KeyboardEvent): string | null {
    if (filtering.value) {
      if (e.key === "Escape") {
        e.preventDefault();
        filterText.value = "";
        filtering.value = false;
        return null;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        filtering.value = false;
        return null;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (filterText.value.length > 0) {
          filterText.value = filterText.value.slice(0, -1);
          snapCursorToFirstVisible();
        } else {
          filtering.value = false;
        }
        return null;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        filterText.value += e.key;
        snapCursorToFirstVisible();
        return null;
      }
      return null;
    }

    // gg sequence
    if (pendingG.value) {
      pendingG.value = false;
      if (pendingGTimer) clearTimeout(pendingGTimer);
      if (e.key === "g") {
        e.preventDefault();
        jumpTop();
        return null;
      }
    }

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1);
        return null;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1);
        return null;
      case "l":
      case "ArrowRight":
      case "Enter":
        e.preventDefault();
        filterText.value = "";
        return navigateRight();
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        filterText.value = "";
        navigateLeft();
        return null;
      case "y":
        e.preventDefault();
        return null;
      case "g":
        if (!e.shiftKey) {
          e.preventDefault();
          pendingG.value = true;
          pendingGTimer = setTimeout(() => { pendingG.value = false; }, 500);
          return null;
        }
        break;
      case "G":
        e.preventDefault();
        jumpBottom();
        return null;
      case "/":
        e.preventDefault();
        filtering.value = true;
        return null;
      default:
        break;
    }

    return null;
  }

  function reset() {
    clearSlideTimer();
    if (pendingGTimer !== null) {
      clearTimeout(pendingGTimer);
      pendingGTimer = null;
    }
    breadcrumb.value = [];
    requestedCursor.value = 0;
    filterText.value = "";
    filtering.value = false;
    cache.clear();
    slideDirection.value = null;
    pendingG.value = false;
    error.value = null;
    showAllFiles.value = false;
  }

  function toggleShowAllFiles() {
    showAllFiles.value = !showAllFiles.value;
    cache.clear();
    error.value = null;
  }

  return {
    state,
    showAllFiles,
    filterText,
    filtering,
    loading,
    error,
    slideDirection,
    handleKey,
    activateCurrentEntry,
    activateParentEntry,
    activatePreviewEntry,
    activateSelectedEntry,
    exitCurrentDirectory,
    currentFilePath,
    jumpToBreadcrumb,
    reset,
    pendingG,
    toggleShowAllFiles,
  };
}
