import { ref, shallowRef, watch, type Ref, computed } from "vue";
import { computedAsync, refDebounced } from "@vueuse/core";
import { invoke } from "../invoke";
import { useToast } from "./useToast";

export interface TreeNode {
  name: string;
  isDir: boolean;
  path: string;
}

interface DirEntryResponse {
  name: string;
  is_dir: boolean;
}

export interface MillerState {
  columns: TreeNode[][];
  cursor: number[];
  activeColumn: number;
  breadcrumb: string[];
}

export function useTreeExplorer(rootPath: Ref<string>, repoRoot: Ref<string>) {
  const cache = new Map<string, TreeNode[]>();
  const fallbackRoot = ref<string | null>(null);
  const effectiveRoot = computed(() => fallbackRoot.value ?? rootPath.value);

  // ── User-driven state ──────────────────────────────────────────
  const breadcrumb = ref<string[]>([]);
  // Number = direct index, string = find entry by name (for cursor restore after navigateLeft)
  const requestedCursor = ref<number | string>(0);
  const filterText = ref("");
  const filtering = ref(false);
  const error = ref<string | null>(null);
  const slideDirection = shallowRef<"left" | "right" | null>(null);
  const pendingG = ref(false);
  let pendingGTimer: ReturnType<typeof setTimeout> | null = null;
  let slideTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Derived paths ──────────────────────────────────────────────
  const currentDirAbs = computed(() => {
    const root = effectiveRoot.value;
    const bc = breadcrumb.value;
    return bc.length === 0 ? root : `${root}/${bc.join("/")}`;
  });

  const parentDirAbs = computed(() => {
    const bc = breadcrumb.value;
    if (bc.length === 0) return null;
    const root = effectiveRoot.value;
    const parentBc = bc.slice(0, -1);
    return parentBc.length === 0 ? root : `${root}/${parentBc.join("/")}`;
  });

  // ── Fetcher ────────────────────────────────────────────────────
  async function fetchDir(dirPath: string): Promise<TreeNode[]> {
    if (cache.has(dirPath)) return cache.get(dirPath)!;

    const entries = await invoke<DirEntryResponse[]>("read_dir_entries", {
      path: dirPath,
      repoRoot: repoRoot.value,
    });

    const root = effectiveRoot.value;
    const nodes: TreeNode[] = entries.map((e) => {
      const rel = dirPath === root
        ? e.name
        : dirPath.slice(root.length + 1) + "/" + e.name;
      return { name: e.name, isDir: e.is_dir, path: rel };
    });

    cache.set(dirPath, nodes);
    return nodes;
  }

  function absolutePath(relativePath: string): string {
    return relativePath ? `${effectiveRoot.value}/${relativePath}` : effectiveRoot.value;
  }

  // ── Reactive columns ───────────────────────────────────────────
  const loading = ref(false);

  const currentEntries = computedAsync(
    async () => {
      const dir = currentDirAbs.value;
      if (!dir) return [];
      try {
        return await fetchDir(dir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const rr = repoRoot.value;
        if (!fallbackRoot.value && effectiveRoot.value !== rr && rr) {
          console.warn("[tree-explorer] rootPath unavailable, falling back to repo root");
          useToast().warning("Worktree missing — showing repo root");
          fallbackRoot.value = rr;
          return [];
        }
        error.value = msg;
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
        return await fetchDir(dir);
      } catch {
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
        return await fetchDir(absolutePath(entry.path));
      } catch {
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
  watch(rootPath, () => {
    breadcrumb.value = [];
    requestedCursor.value = 0;
    filterText.value = "";
    filtering.value = false;
    error.value = null;
    cache.clear();
    fallbackRoot.value = null;
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

  function navigateLeft() {
    if (breadcrumb.value.length === 0) return;

    triggerSlide("right");
    requestedCursor.value = breadcrumb.value[breadcrumb.value.length - 1];
    breadcrumb.value = breadcrumb.value.slice(0, -1);
    filterText.value = "";
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
    fallbackRoot.value = null;
    slideDirection.value = null;
    pendingG.value = false;
    error.value = null;
  }

  return {
    state,
    filterText,
    filtering,
    loading,
    error,
    slideDirection,
    handleKey,
    currentFilePath,
    jumpToBreadcrumb,
    reset,
    pendingG,
  };
}
