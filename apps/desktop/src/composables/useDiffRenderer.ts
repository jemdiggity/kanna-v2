import { nextTick, ref, type Ref } from "vue";
import {
  FileDiff,
  parsePatchFiles,
  setLanguageOverride,
  type AnnotationSide,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  getOrCreateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import {
  getSyntaxLanguageForPath,
  isBazelSyntaxPath,
} from "../utils/syntaxLanguage";
import { normalizeGitPatchForDiffParser } from "../utils/normalizeGitPatch";
import type { DiffSearchFile } from "../utils/diffSearch";

export type DiffRenderTheme = "github-dark" | "github-light";

export interface DiffRenderContext {
  loadId: number;
  loadStartedAt: number;
}

export interface DiffReviewAnchor {
  filePath: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  overlayTop?: number;
}

interface DiffFilePathMetadata {
  newName?: string;
  oldName?: string;
  fileName?: string;
}

interface DiffWorkerPoolStats {
  managerState?: string;
  totalWorkers?: number;
  workersFailed?: boolean;
  busyWorkers?: number;
  queuedTasks?: number;
  pendingTasks?: number;
  diffCacheSize?: number;
}

interface DiffWorkerPoolInspector {
  getStats?: () => DiffWorkerPoolStats;
  isInitialized?: () => boolean;
}

interface DiffRenderFileEntry {
  id: string;
  rawFileMeta: FileDiffMetadata & DiffFilePathMetadata;
  displayPath: string;
  wrapper: HTMLDivElement;
  skipReason?: "oversized";
}

interface DiffRenderProgress {
  completedFiles: number;
  firstCompletedAt: number | null;
  completedAllLogged: boolean;
  firstCompletedWaiters: Array<() => void>;
}

interface UseDiffRendererOptions {
  containerRef: Ref<HTMLElement | null>;
  diffTheme: Readonly<Ref<DiffRenderTheme>>;
  t: (key: string) => string;
  isActiveDiffLoad: (loadId: number) => boolean;
  restoreScrollPositionForActiveLoad: (context: DiffRenderContext) => void;
  finishPendingScrollRestore: (context: DiffRenderContext) => void;
  applySearchHighlights: () => void;
  setNoDiff: (noDiff: boolean) => void;
  reviewEnabled: Readonly<Ref<boolean>>;
  onReviewAnchor?: (anchor: DiffReviewAnchor) => void;
}

const DIFF_RENDER_BATCH_SIZE = 12;
const DIFF_INITIAL_RENDER_BATCH_SIZE = 1;
const MAX_RENDERABLE_DIFF_LINE_LENGTH = 250_000;
const MAX_RENDERABLE_DIFF_FILE_CONTENT_LENGTH = 2_000_000;

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

async function waitForRenderTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForFirstRenderedFile(
  progress: DiffRenderProgress,
  timeoutMs = 5000,
): Promise<void> {
  if (progress.firstCompletedAt != null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const index = progress.firstCompletedWaiters.indexOf(finish);
      if (index >= 0) {
        progress.firstCompletedWaiters.splice(index, 1);
      }
      resolve();
    };
    progress.firstCompletedWaiters.push(finish);
    setTimeout(finish, timeoutMs);
  });
}

function getWorkerPoolStatsSnapshot(pool: WorkerPoolManager | null): DiffWorkerPoolStats | null {
  if (pool == null) return null;
  const inspector = pool as WorkerPoolManager & DiffWorkerPoolInspector;
  if (typeof inspector.getStats !== "function") return null;
  return inspector.getStats();
}

function getDisplayPath(fileMeta: FileDiffMetadata & DiffFilePathMetadata): string {
  return fileMeta.name || fileMeta.newName || fileMeta.oldName || fileMeta.fileName || "";
}

function logDiffPerf(
  loadId: number,
  stage: string,
  details: Record<string, unknown>,
) {
  console.warn(`[DiffView][perf] load#${loadId} ${stage}`, details);
}

function createDiffFileWrapper(entry: { id: string; displayPath: string }): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-file";
  wrapper.dataset.fileId = entry.id;

  const header = document.createElement("div");
  header.className = "diff-file-header";
  header.textContent = entry.displayPath;
  header.title = entry.displayPath;
  wrapper.appendChild(header);

  return wrapper;
}

function getDiffLineCollections(fileMeta: FileDiffMetadata): string[][] {
  const maybeLineCollections = fileMeta as FileDiffMetadata & {
    additionLines?: string[];
    deletionLines?: string[];
  };
  return [
    maybeLineCollections.additionLines ?? [],
    maybeLineCollections.deletionLines ?? [],
  ];
}

function shouldSkipDiffFileRender(fileMeta: FileDiffMetadata): boolean {
  let totalContentLength = 0;
  for (const lines of getDiffLineCollections(fileMeta)) {
    for (const line of lines) {
      if (line.length > MAX_RENDERABLE_DIFF_LINE_LENGTH) {
        return true;
      }
      totalContentLength += line.length;
      if (totalContentLength > MAX_RENDERABLE_DIFF_FILE_CONTENT_LENGTH) {
        return true;
      }
    }
  }
  return false;
}

function resolveRenderableFileMeta(
  rawFileMeta: FileDiffMetadata & DiffFilePathMetadata,
  displayPath: string,
): FileDiffMetadata {
  if (!isBazelSyntaxPath(displayPath)) {
    return rawFileMeta;
  }

  return setLanguageOverride(
    rawFileMeta,
    getSyntaxLanguageForPath(displayPath) as "python"
  );
}

function getContentLineNumber(
  hunk: FileDiffMetadata["hunks"][number],
  content: FileDiffMetadata["hunks"][number]["hunkContent"][number],
  side: AnnotationSide,
): number {
  if (side === "additions") {
    return hunk.additionStart + (content.additionLineIndex - hunk.additionLineIndex);
  }
  return hunk.deletionStart + (content.deletionLineIndex - hunk.deletionLineIndex);
}

function getContentLineIndex(
  content: FileDiffMetadata["hunks"][number]["hunkContent"][number],
  side: AnnotationSide,
): number {
  return side === "additions" ? content.additionLineIndex : content.deletionLineIndex;
}

function getContentLineCount(
  content: FileDiffMetadata["hunks"][number]["hunkContent"][number],
  side: AnnotationSide,
): number {
  if (content.type === "context") return content.lines;
  return side === "additions" ? content.additions : content.deletions;
}

function findLineText(
  fileMeta: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number,
): string | null {
  const lines = side === "additions" ? fileMeta.additionLines : fileMeta.deletionLines;
  for (const hunk of fileMeta.hunks) {
    for (const content of hunk.hunkContent) {
      const contentLineCount = getContentLineCount(content, side);
      if (contentLineCount <= 0) continue;
      const contentStartLine = getContentLineNumber(hunk, content, side);
      const offset = lineNumber - contentStartLine;
      if (offset >= 0 && offset < contentLineCount) {
        return lines[getContentLineIndex(content, side) + offset] ?? null;
      }
    }
  }
  return null;
}

function collectExcerpt(
  fileMeta: FileDiffMetadata,
  side: AnnotationSide,
  startLine: number,
  endLine: number,
): string {
  const firstLine = Math.min(startLine, endLine);
  const lastLine = Math.max(startLine, endLine);
  const excerptLines: string[] = [];
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const lineText = findLineText(fileMeta, side, lineNumber);
    if (lineText != null) {
      excerptLines.push(lineText);
    }
  }
  return excerptLines.join("\n");
}

function getOverlayTop(container: HTMLElement | null, lineElement?: HTMLElement): number | undefined {
  if (!container || !lineElement) return undefined;
  const containerRect = container.getBoundingClientRect();
  const lineRect = lineElement.getBoundingClientRect();
  return Math.max(0, lineRect.top - containerRect.top + container.scrollTop);
}

export function useDiffRenderer(options: UseDiffRendererOptions) {
  const renderedFiles = ref<DiffSearchFile[]>([]);
  let workerPool: WorkerPoolManager | null = null;
  let fileDiffInstances: FileDiff[] = [];

  function cleanupInstance() {
    fileDiffInstances = [];
    // Clear rendered diff elements safely
    if (options.containerRef.value) {
      while (options.containerRef.value.firstChild) {
        options.containerRef.value.removeChild(options.containerRef.value.firstChild);
      }
    }
  }

  async function initWorkerPool() {
    if (workerPool) {
      await (workerPool as WorkerPoolManager & {
        setRenderOptions?: (options: { theme: string; lineDiffType: "word" }) => Promise<void>;
      }).setRenderOptions?.({
        theme: options.diffTheme.value,
        lineDiffType: "word",
      });
      return workerPool;
    }
    try {
      workerPool = getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: () =>
            new Worker(
              new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
              { type: "module" }
            ),
        },
        highlighterOptions: {
          theme: options.diffTheme.value,
          lineDiffType: "word",
        },
      });
      return workerPool;
    } catch (e) {
      console.warn("[DiffView] Worker pool init failed, falling back:", e);
      return null;
    }
  }

  function renderSkippedDiffFile(entry: DiffRenderFileEntry, context: DiffRenderContext): void {
    const skipped = document.createElement("div");
    skipped.className = "diff-file-skipped";
    skipped.textContent = options.t("diffView.fileSkippedTooLarge");
    entry.wrapper.appendChild(skipped);

    logDiffPerf(context.loadId, "render:file_skipped", {
      path: entry.displayPath,
      reason: entry.skipReason,
    });
  }

  function renderDiffFile(
    entry: DiffRenderFileEntry,
    pool: WorkerPoolManager | null,
    context: DiffRenderContext,
    allFilesCount: number,
    progress: DiffRenderProgress,
    fileIndex: number,
  ): void {
    const fileRenderStartedAt = performance.now();
    let didLogPostRender = false;
    const fileMeta = resolveRenderableFileMeta(entry.rawFileMeta, entry.displayPath);

    function openReviewAnchor(
      side: AnnotationSide,
      startLine: number,
      endLine: number,
      lineElement?: HTMLElement,
    ): void {
      if (!options.reviewEnabled.value) return;
      options.onReviewAnchor?.({
        filePath: entry.displayPath,
        startLine: Math.min(startLine, endLine),
        endLine: Math.max(startLine, endLine),
        excerpt: collectExcerpt(fileMeta, side, startLine, endLine),
        overlayTop: getOverlayTop(options.containerRef.value, lineElement),
      });
    }

    const instance = new FileDiff(
      {
        theme: options.diffTheme.value,
        diffStyle: "unified",
        diffIndicators: "classic",
        disableFileHeader: true,
        lineHoverHighlight: "number",
        enableLineSelection: true,
        onLineNumberClick: (props) => {
          openReviewAnchor(
            props.annotationSide,
            props.lineNumber,
            props.lineNumber,
            props.lineElement,
          );
        },
        onLineSelected: (range: SelectedLineRange | null) => {
          if (!range || range.start === range.end) return;
          if (range.side && range.endSide && range.side !== range.endSide) return;
          openReviewAnchor(range.side ?? "additions", range.start, range.end);
        },
        onPostRender: () => {
          if (didLogPostRender || !options.isActiveDiffLoad(context.loadId)) return;
          didLogPostRender = true;
          nextTick(() => {
            options.restoreScrollPositionForActiveLoad(context);
            options.applySearchHighlights();
          });
          const completedAt = performance.now();
          const sinceFileStartMs = completedAt - fileRenderStartedAt;
          const sinceLoadStartMs = completedAt - context.loadStartedAt;
          progress.completedFiles += 1;
          if (progress.firstCompletedAt == null) {
            progress.firstCompletedAt = completedAt;
            for (const resolve of progress.firstCompletedWaiters.splice(0)) {
              resolve();
            }
            logDiffPerf(context.loadId, "content:first_file_ready", {
              durationMs: roundDuration(sinceLoadStartMs),
              fileIndex,
              fileCount: allFilesCount,
              path: entry.displayPath,
              workerStats: getWorkerPoolStatsSnapshot(pool),
            });
          }
          if (sinceFileStartMs >= 250) {
            logDiffPerf(context.loadId, "content:file_ready", {
              fileIndex,
              fileCount: allFilesCount,
              path: entry.displayPath,
              sinceFileStartMs: roundDuration(sinceFileStartMs),
              sinceLoadStartMs: roundDuration(sinceLoadStartMs),
              workerStats: getWorkerPoolStatsSnapshot(pool),
            });
          }
          if (!progress.completedAllLogged && progress.completedFiles === allFilesCount) {
            progress.completedAllLogged = true;
            options.finishPendingScrollRestore(context);
            logDiffPerf(context.loadId, "content:all_files_ready", {
              durationMs: roundDuration(sinceLoadStartMs),
              fileCount: allFilesCount,
              firstContentMs: roundDuration(
                (progress.firstCompletedAt ?? completedAt) - context.loadStartedAt,
              ),
              workerStats: getWorkerPoolStatsSnapshot(pool),
            });
          }
        },
      },
      pool || undefined
    );

    instance.render({
      fileDiff: fileMeta,
      containerWrapper: entry.wrapper,
    });

    fileDiffInstances.push(instance);

    logDiffPerf(context.loadId, "render:file_invoked", {
      fileIndex,
      fileCount: allFilesCount,
      path: entry.displayPath,
      syncMs: roundDuration(performance.now() - fileRenderStartedAt),
      workerStats: getWorkerPoolStatsSnapshot(pool),
    });
  }

  async function renderDiff(patch: string, context: DiffRenderContext) {
    if (!options.containerRef.value) return;

    const normalizedPatchStartedAt = performance.now();
    const normalizedPatch = normalizeGitPatchForDiffParser(patch);
    const normalizedPatchDurationMs = performance.now() - normalizedPatchStartedAt;

    const parseStartedAt = performance.now();
    const patches = parsePatchFiles(normalizedPatch);
    const parseDurationMs = performance.now() - parseStartedAt;
    const allFiles = patches?.flatMap((p) => p.files || []) || [];
    if (allFiles.length === 0) {
      options.setNoDiff(true);
      renderedFiles.value = [];
      cleanupInstance();
      logDiffPerf(context.loadId, "parse:empty", {
        totalMs: roundDuration(performance.now() - context.loadStartedAt),
        normalizeMs: roundDuration(normalizedPatchDurationMs),
        parseMs: roundDuration(parseDurationMs),
      });
      return;
    }

    logDiffPerf(context.loadId, "parse:done", {
      normalizeMs: roundDuration(normalizedPatchDurationMs),
      parseMs: roundDuration(parseDurationMs),
      patchCount: patches.length,
      fileCount: allFiles.length,
    });

    const renderEntries: DiffRenderFileEntry[] = allFiles.map((rawFileMeta, fileIndex) => {
      const typedFileMeta = rawFileMeta as FileDiffMetadata & DiffFilePathMetadata;
      const id = `${context.loadId}:${fileIndex}`;
      const displayPath = getDisplayPath(typedFileMeta);
      return {
        id,
        rawFileMeta: typedFileMeta,
        displayPath,
        wrapper: createDiffFileWrapper({ id, displayPath }),
        skipReason: shouldSkipDiffFileRender(typedFileMeta) ? "oversized" : undefined,
      };
    });

    const renderableEntries = renderEntries.filter((entry) => entry.skipReason == null);

    renderedFiles.value = renderableEntries.map((entry) => ({
      id: entry.id,
      fileDiff: entry.rawFileMeta,
    }));

    const workerInitStartedAt = performance.now();
    const pool = await initWorkerPool();
    logDiffPerf(context.loadId, "worker_pool:ready", {
      durationMs: roundDuration(performance.now() - workerInitStartedAt),
      stats: getWorkerPoolStatsSnapshot(pool),
    });

    const cleanupStartedAt = performance.now();
    cleanupInstance();
    logDiffPerf(context.loadId, "cleanup:done", {
      durationMs: roundDuration(performance.now() - cleanupStartedAt),
    });

    for (const entry of renderEntries) {
      options.containerRef.value.appendChild(entry.wrapper);
    }

    const progress: DiffRenderProgress = {
      completedFiles: 0,
      firstCompletedAt: null,
      completedAllLogged: false,
      firstCompletedWaiters: [],
    };

    for (const entry of renderEntries) {
      if (entry.skipReason) {
        renderSkippedDiffFile(entry, context);
      }
    }

    for (let batchStart = 0; batchStart < renderableEntries.length;) {
      if (!options.isActiveDiffLoad(context.loadId)) {
        return;
      }

      const batchSize = batchStart === 0 ? DIFF_INITIAL_RENDER_BATCH_SIZE : DIFF_RENDER_BATCH_SIZE;
      const batch = renderableEntries.slice(batchStart, batchStart + batchSize);
      const batchStartedAt = performance.now();

      for (const [batchIndex, entry] of batch.entries()) {
        renderDiffFile(
          entry,
          pool,
          context,
          renderableEntries.length,
          progress,
          batchStart + batchIndex,
        );
      }

      logDiffPerf(context.loadId, "render:batch_invoked", {
        batchIndex: Math.floor(batchStart / DIFF_RENDER_BATCH_SIZE),
        batchSize: batch.length,
        renderedCount: Math.min(batchStart + batch.length, renderableEntries.length),
        fileCount: renderableEntries.length,
        durationMs: roundDuration(performance.now() - batchStartedAt),
        workerStats: getWorkerPoolStatsSnapshot(pool),
      });

      if (batchStart + batch.length < renderableEntries.length) {
        if (batchStart === 0) {
          await waitForFirstRenderedFile(progress);
        }
        await waitForRenderTurn();
      }

      batchStart += batch.length;
    }

    logDiffPerf(context.loadId, "render:scheduled", {
      totalMs: roundDuration(performance.now() - context.loadStartedAt),
      fileCount: renderableEntries.length,
      skippedFileCount: renderEntries.length - renderableEntries.length,
      workerStats: getWorkerPoolStatsSnapshot(pool),
    });
  }

  return {
    renderedFiles,
    cleanupInstance,
    initWorkerPool,
    renderDiff,
  };
}
