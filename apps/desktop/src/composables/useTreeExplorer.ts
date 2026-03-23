import { ref, shallowRef } from "vue";
import { invoke } from "../invoke";

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

export function useTreeExplorer(rootPath: () => string, repoRoot: () => string) {
  const cache = new Map<string, TreeNode[]>();

  const state = ref<MillerState>({
    columns: [[], [], []],
    cursor: [0, 0, 0],
    activeColumn: 1,
    breadcrumb: [],
  });

  const filterText = ref("");
  const loading = ref(false);
  const slideDirection = shallowRef<"left" | "right" | null>(null);

  // Pending g key for gg sequence
  const pendingG = ref(false);
  let pendingGTimer: ReturnType<typeof setTimeout> | null = null;

  // Slide direction cleanup timer
  let slideTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSlideTimer() {
    if (slideTimer !== null) {
      clearTimeout(slideTimer);
      slideTimer = null;
    }
  }

  async function fetchDir(dirPath: string): Promise<TreeNode[]> {
    if (cache.has(dirPath)) return cache.get(dirPath)!;

    const entries = await invoke<DirEntryResponse[]>("read_dir_entries", {
      path: dirPath,
      repoRoot: repoRoot(),
    });

    const nodes: TreeNode[] = entries.map((e) => {
      const root = rootPath();
      const rel = dirPath === root
        ? e.name
        : dirPath.slice(root.length + 1) + "/" + e.name;
      return { name: e.name, isDir: e.is_dir, path: rel };
    });

    cache.set(dirPath, nodes);
    return nodes;
  }

  function absolutePath(relativePath: string): string {
    return relativePath ? `${rootPath()}/${relativePath}` : rootPath();
  }

  function breadcrumbToAbsolute(segments: string[]): string {
    return segments.length === 0
      ? rootPath()
      : `${rootPath()}/${segments.join("/")}`;
  }

  async function prefetch(node: TreeNode) {
    if (!node.isDir) return;
    const absPath = absolutePath(node.path);
    if (!cache.has(absPath)) {
      fetchDir(absPath).catch(() => {
      // Prefetch is best-effort — failure is non-fatal
    });
    }
  }

  async function open(initialPath?: string) {
    const startPath = initialPath ?? rootPath();
    const bc = startPath === rootPath()
      ? []
      : startPath.replace(rootPath() + "/", "").split("/");

    state.value.breadcrumb = bc;
    loading.value = true;

    try {
      const currentAbs = breadcrumbToAbsolute(bc);
      const currentEntries = await fetchDir(currentAbs);

      // Parent column
      let parentEntries: TreeNode[] = [];
      if (bc.length > 0) {
        const parentBc = bc.slice(0, -1);
        const parentAbs = breadcrumbToAbsolute(parentBc);
        parentEntries = await fetchDir(parentAbs);
      }

      // Preview column (first dir entry's children, or first entry)
      let previewEntries: TreeNode[] = [];
      const firstDir = currentEntries.find((e) => e.isDir);
      if (firstDir) {
        previewEntries = await fetchDir(absolutePath(firstDir.path));
      }

      state.value.columns = [parentEntries, currentEntries, previewEntries];
      state.value.cursor = [
        // Parent cursor: index of current dir in parent
        bc.length > 0
          ? parentEntries.findIndex((e) => e.name === bc[bc.length - 1])
          : 0,
        0,
        0,
      ];
      state.value.activeColumn = 1;
      filterText.value = "";

      // Prefetch one level ahead for visible dirs
      for (const entry of currentEntries.slice(0, 20)) {
        prefetch(entry);
      }
    } finally {
      loading.value = false;
    }
  }

  async function navigateRight(): Promise<string | null> {
    const col = state.value.columns[1];
    const idx = state.value.cursor[1];
    const entry = col?.[idx];
    if (!entry) return null;

    if (!entry.isDir) {
      // Return file path for opening
      return entry.path;
    }

    // Enter directory
    slideDirection.value = "left";
    const newBc = [...state.value.breadcrumb, entry.name];
    state.value.breadcrumb = newBc;

    const newCurrentAbs = absolutePath(entry.path);
    const newCurrentEntries = await fetchDir(newCurrentAbs);

    // Current becomes parent, preview becomes current
    const oldCurrent = state.value.columns[1];
    const oldCursorIdx = state.value.cursor[1];

    let previewEntries: TreeNode[] = [];
    const firstDir = newCurrentEntries.find((e) => e.isDir);
    if (firstDir) {
      previewEntries = await fetchDir(absolutePath(firstDir.path));
    }

    state.value.columns = [oldCurrent, newCurrentEntries, previewEntries];
    state.value.cursor = [oldCursorIdx, 0, 0];
    filterText.value = "";

    // Prefetch
    for (const e of newCurrentEntries.slice(0, 20)) {
      prefetch(e);
    }

    // Clear slide direction after animation
    clearSlideTimer();
    slideTimer = setTimeout(() => { slideDirection.value = null; }, 200);
    return null;
  }

  async function navigateLeft() {
    if (state.value.breadcrumb.length === 0) return;

    slideDirection.value = "right";
    // Capture the dir name we're leaving BEFORE mutating breadcrumb
    const leavingDirName = state.value.breadcrumb[state.value.breadcrumb.length - 1];
    const newBc = state.value.breadcrumb.slice(0, -1);
    state.value.breadcrumb = newBc;

    // Parent becomes new current
    const newCurrentAbs = breadcrumbToAbsolute(newBc);
    const newCurrentEntries = await fetchDir(newCurrentAbs);

    // Fetch new parent
    let newParentEntries: TreeNode[] = [];
    if (newBc.length > 0) {
      const parentBc = newBc.slice(0, -1);
      newParentEntries = await fetchDir(breadcrumbToAbsolute(parentBc));
    }

    // Old current becomes preview (the column we just left)
    const oldCurrent = state.value.columns[1];

    // Restore cursor to the directory we just navigated out of
    const restoredIdx = newCurrentEntries.findIndex((e) => e.name === leavingDirName);

    state.value.columns = [newParentEntries, newCurrentEntries, oldCurrent];
    state.value.cursor = [
      newBc.length > 0
        ? newParentEntries.findIndex((e) => e.name === newBc[newBc.length - 1])
        : 0,
      restoredIdx >= 0 ? restoredIdx : 0,
      0,
    ];
    filterText.value = "";

    clearSlideTimer();
    slideTimer = setTimeout(() => { slideDirection.value = null; }, 200);
  }

  // Debounced preview update — only fires after cursor rests for 50ms
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewSeq = 0;

  function updatePreview(entry: TreeNode | undefined) {
    if (previewTimer) clearTimeout(previewTimer);
    const seq = ++previewSeq;

    previewTimer = setTimeout(() => {
      if (seq !== previewSeq) return;

      if (entry?.isDir) {
        fetchDir(absolutePath(entry.path)).then((previewEntries) => {
          if (seq === previewSeq) {
            state.value.columns[2] = previewEntries;
            state.value.cursor[2] = 0;
          }
        }).catch(() => {
          // Preview fetch is best-effort
        });
      } else {
        state.value.columns[2] = [];
        state.value.cursor[2] = 0;
      }
    }, 50);
  }

  function moveCursor(delta: number) {
    const col = state.value.columns[1];
    if (!col?.length) return;
    const newIdx = Math.max(0, Math.min(col.length - 1, state.value.cursor[1] + delta));
    state.value.cursor[1] = newIdx;

    // Debounced preview update — cursor moves instantly, preview waits for pause
    updatePreview(col[newIdx]);
  }

  function jumpTop() {
    state.value.cursor[1] = 0;
    // Trigger preview update
    moveCursor(0);
  }

  function jumpBottom() {
    const col = state.value.columns[1];
    if (!col?.length) return;
    state.value.cursor[1] = col.length - 1;
    moveCursor(0);
  }

  async function jumpToBreadcrumb(index: number) {
    const newBc = state.value.breadcrumb.slice(0, index);
    // Re-open at that level
    const targetPath = newBc.length === 0 ? rootPath() : `${rootPath()}/${newBc.join("/")}`;
    await open(targetPath);
  }

  function currentFilePath(): string | null {
    const col = state.value.columns[1];
    const idx = state.value.cursor[1];
    const entry = col?.[idx];
    return entry?.path ?? null;
  }

  /** Handle a key event. Returns file path string if a file should be opened, null otherwise. */
  async function handleKey(e: KeyboardEvent): Promise<string | null> {
    // Filter mode: typing characters
    if (filterText.value && e.key === "Escape") {
      e.preventDefault();
      filterText.value = "";
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
        return await navigateRight();
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        await navigateLeft();
        return null;
      case "y":
        e.preventDefault();
        // Yank path handled by component (needs clipboard API)
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
        // Focus filter — handled by component
        return null;
      case "Backspace":
        e.preventDefault();
        if (filterText.value.length > 0) {
          filterText.value = filterText.value.slice(0, -1);
        }
        return null;
      default:
        // Type-to-filter: printable characters
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          filterText.value += e.key;
          return null;
        }
    }

    return null;
  }

  function reset() {
    clearSlideTimer();
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (pendingGTimer !== null) {
      clearTimeout(pendingGTimer);
      pendingGTimer = null;
    }
    state.value = {
      columns: [[], [], []],
      cursor: [0, 0, 0],
      activeColumn: 1,
      breadcrumb: [],
    };
    filterText.value = "";
    cache.clear();
    slideDirection.value = null;
    pendingG.value = false;
  }

  return {
    state,
    filterText,
    loading,
    slideDirection,
    open,
    handleKey,
    currentFilePath,
    jumpToBreadcrumb,
    reset,
    pendingG,
  };
}
