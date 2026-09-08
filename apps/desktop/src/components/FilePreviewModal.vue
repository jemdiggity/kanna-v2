<script setup lang="ts">
import type MarkdownIt from "markdown-it";
import type { BundledLanguage, ShikiTransformer } from "shiki";
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../invoke";
import { useLessScroll } from "../composables/useLessScroll";
import {
  registerContextShortcuts,
  setContextShortcuts,
  type ContextShortcut,
} from "../composables/useShortcutContext";
import { useInlineSearch } from "../composables/useInlineSearch";
import {
  useEmbeddableView,
  type EmbeddableViewProps,
} from "../composables/useEmbeddableView";
import { macOsTextInputAttrs } from "../utils/textInput";
import { getSyntaxLanguageForPath } from "../utils/syntaxLanguage";
import { getShikiTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  type MarkdownPreviewMode,
} from "../stores/markdownPreviewMode";

const { t } = useI18n();
const { effectiveCodeTheme } = useThemeRuntime();
const shikiTheme = computed(() => getShikiTheme(effectiveCodeTheme.value));

const props = withDefaults(
  defineProps<EmbeddableViewProps & {
    filePath: string;
    worktreePath: string;
    /**
     * Point-in-time file content fetched from another machine. When set, the
     * modal renders this instead of reading the local worktree, and local-only
     * actions (open in IDE) are hidden.
     */
    remoteContent?: string | null;
    remoteContentLoader?: (path: string) => Promise<string>;
    ideCommand?: string;
    maximized?: boolean;
    initialLine?: number;
    initialMarkdownMode?: MarkdownPreviewMode;
    standalone?: boolean;
  }>(),
  {
    remoteContent: null,
    initialMarkdownMode: DEFAULT_MARKDOWN_PREVIEW_MODE,
  },
);
const { zIndex, bringToFront, overlayClass, overlayStyle, dismissOnScrimClick, isForeground } =
  useEmbeddableView(props, { context: "file" });
const isRemoteFile = computed(() =>
  props.remoteContent !== null || props.remoteContentLoader !== undefined
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update-markdown-mode", mode: MarkdownPreviewMode): void;
}>();

const contentRef = ref<HTMLElement | null>(null);
const modalRef = ref<HTMLElement | null>(null);


const content = ref("");

const {
  isSearching,
  query: searchQuery,
  matchCount: searchMatchCount,
  currentMatch: searchCurrentMatch,
  decorations: searchDecorations,
  closeSearch,
  handleSearchKeys,
  handleInputKeys,
} = useInlineSearch(content);

const searchInputRef = ref<HTMLInputElement | null>(null);

const showLineNumbers = ref(false);
const fileContextShortcuts: ContextShortcut[] = [
  { label: t('filePreview.shortcutSearch'), display: "/", groupKey: "shortcuts.groupSearch" },
  { label: t('filePreview.shortcutSearchAlt'), display: "⌘F", groupKey: "shortcuts.groupSearch" },
  { label: t('filePreview.shortcutNextPrevMatch'), display: "n / N", groupKey: "shortcuts.groupSearch" },
  { label: t('filePreview.shortcutLineUpDown'), display: "j / k", groupKey: "shortcuts.groupNavigation" },
  { label: t('filePreview.shortcutPageUpDown'), display: "f / b", groupKey: "shortcuts.groupNavigation" },
  { label: t('filePreview.shortcutHalfUpDown'), display: "d / u", groupKey: "shortcuts.groupNavigation" },
  { label: t('filePreview.shortcutTopBottom'), display: "g / G", groupKey: "shortcuts.groupNavigation" },
  { label: t('filePreview.shortcutToggleLineNumbers'), display: "l", groupKey: "shortcuts.groupViews" },
  ...(props.filePath.toLowerCase().endsWith(".md")
    ? [{ label: t('filePreview.shortcutToggleMarkdown'), display: "m", groupKey: "shortcuts.groupViews" }]
    : []),
  ...(!isRemoteFile.value
    ? [{ label: t('filePreview.shortcutOpenIDE'), display: "⌘O", groupKey: "shortcuts.groupActions" }]
    : []),
  { label: t('filePreview.shortcutClose'), display: "q", groupKey: "shortcuts.groupActions" },
];
registerContextShortcuts("file", fileContextShortcuts);
// Several file tabs can be mounted at once. Whichever one the reader
// brings forward owns the contextual shortcut list.
watch(
  () => props.active,
  (active) => {
    if (!props.embedded || !active) return;
    setContextShortcuts("file", fileContextShortcuts);
  },
);
const highlighted = ref("");
const currentLang = ref("text");
const loading = ref(true);
const error = ref<string | null>(null);

const isMarkdownFile = computed(() =>
  props.filePath.toLowerCase().endsWith(".md")
);
const renderMarkdown = ref(
  props.initialMarkdownMode === "rendered" && isMarkdownFile.value,
);

const lineCount = computed(() => {
  if (!content.value) return 0;
  return content.value.split('\n').length;
});

type ShikiModule = typeof import("shiki");
type ShikiHighlighter = Awaited<ReturnType<ShikiModule["createHighlighter"]>>;
type HastElement = Parameters<NonNullable<ShikiTransformer["pre"]>>[0];
type ShikiLanguage = BundledLanguage | "text";

function toShikiLanguage(lang: string): ShikiLanguage {
  return lang === "text" ? "text" : lang as BundledLanguage;
}

// Lazy-load shiki to avoid blocking startup
let highlighter: ShikiHighlighter | null = null;

async function getHighlighter() {
  if (highlighter) return highlighter;
  const { createHighlighter } = await import("shiki");
  highlighter = await createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: [],
  });
  return highlighter;
}

// Lazy-load markdown-it to avoid blocking startup
let md: MarkdownIt | null = null;

async function getMarkdownIt() {
  if (md) return md;
  const [{ default: MarkdownIt }, { default: taskLists }, { default: strikethrough }] =
    await Promise.all([
      import("markdown-it"),
      import("markdown-it-task-lists"),
      import("markdown-it-strikethrough-alt"),
    ]);

  const hl = await getHighlighter();

  md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight(str: string, lang: string) {
      if (!lang) return hl.codeToHtml(str, { lang: "text", theme: shikiTheme.value });
      // Languages are pre-loaded in the watcher before md.render() is called,
      // so getLoadedLanguages() is reliable here (no async needed).
      const loaded = hl.getLoadedLanguages();
      const useLang = loaded.includes(toShikiLanguage(lang)) ? toShikiLanguage(lang) : "text";
      return hl.codeToHtml(str, { lang: useLang, theme: shikiTheme.value });
    },
  });
  md.use(taskLists, { enabled: false });
  md.use(strikethrough);
  return md;
}

const renderedMarkdown = ref("");

watch([renderMarkdown, content, effectiveCodeTheme], async ([shouldRender, raw]) => {
  if (!shouldRender || !raw) {
    renderedMarkdown.value = "";
    return;
  }
  const parser = await getMarkdownIt();
  const hl = await getHighlighter();

  // Pre-load all fenced code block languages before rendering,
  // because markdown-it's highlight callback is synchronous.
  const langMatches = raw.matchAll(/^```(\w+)/gm);
  const langs = [...new Set([...langMatches].map((m) => m[1]))];
  await Promise.all(
    langs.map((lang) =>
      hl.loadLanguage(toShikiLanguage(lang)).catch((error: unknown) => {
        console.debug(`[file-preview] failed to preload markdown code language "${lang}"; using text fallback:`, error);
      })
    )
  );

  renderedMarkdown.value = parser.render(raw);
});

async function loadFile() {
  loading.value = true;
  error.value = null;
  try {
    const raw = props.remoteContentLoader
      ? await props.remoteContentLoader(props.filePath)
      : props.remoteContent !== null
        ? props.remoteContent
        : await invoke<string>("read_text_file", { path: `${props.worktreePath}/${props.filePath}` });

    const hl = await getHighlighter();
    const lang = getSyntaxLanguageForPath(props.filePath);

    try {
      await hl.loadLanguage(toShikiLanguage(lang));
    } catch (error) {
      console.debug(`[file-preview] failed to load syntax language "${lang}"; using text fallback:`, error);
      // Language not available — fall back to text
    }

    const loadedLangs = hl.getLoadedLanguages();
    // Set lang before content so the watcher fires once with the correct language
    currentLang.value = loadedLangs.includes(toShikiLanguage(lang)) ? lang : "text";
    content.value = raw;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function toggleMarkdownMode() {
  if (!isMarkdownFile.value) return;
  renderMarkdown.value = !renderMarkdown.value;
  emit("update-markdown-mode", renderMarkdown.value ? "rendered" : "raw");
}

// Debounce Shiki re-tokenization: content/lang changes render immediately,
// but decoration-only changes (search keystrokes) are debounced 150ms.
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let prevContent = "";
let prevLang = "";
let prevTheme = shikiTheme.value;

async function renderHighlighted(raw: string, lang: string, decos: typeof searchDecorations.value) {
  if (!raw) { highlighted.value = ""; return; }
  try {
    const hl = await getHighlighter();
    const wrapTransformer: ShikiTransformer = {
      pre(node: HastElement) {
        node.properties.style = "white-space:pre-wrap;word-wrap:break-word;";
      },
      line(node: HastElement, lineNumber: number) {
        node.properties["data-line"] = lineNumber;
      },
    };
    highlighted.value = hl.codeToHtml(raw, {
      lang: toShikiLanguage(lang),
      theme: shikiTheme.value,
      decorations: decos,
      transformers: [wrapTransformer],
    });
  } catch (e: unknown) {
    console.error("[FilePreview] highlight failed:", e);
  }
}

watch([content, currentLang, searchDecorations, effectiveCodeTheme], ([raw, lang, decos]) => {
  if (highlightTimer) clearTimeout(highlightTimer);
  const theme = shikiTheme.value;
  // Content, language, or theme changed — render immediately
  if (raw !== prevContent || lang !== prevLang || theme !== prevTheme) {
    prevContent = raw;
    prevLang = lang;
    prevTheme = theme;
    renderHighlighted(raw, lang, decos);
  } else {
    // Decoration-only change (search keystroke) — debounce 150ms
    highlightTimer = setTimeout(() => renderHighlighted(raw, lang, decos), 150);
  }
}, { immediate: false });

watch(() => props.filePath, () => {
  closeSearch();
});

watch(() => props.remoteContent, () => {
  loadFile();
});

watch(() => props.remoteContentLoader, () => {
  loadFile();
});

watch(highlighted, () => {
  nextTick(() => {
    contentRef.value
      ?.querySelector(".search-hl-active")
      ?.scrollIntoView({ block: "center" });
  });
});

watch(isSearching, (searching) => {
  if (searching) {
    nextTick(() => searchInputRef.value?.focus());
  }
});

let scrolledToLine = false;

watch([loading, highlighted], async ([isLoading]) => {
  if (isLoading || !props.initialLine || scrolledToLine) return;
  scrolledToLine = true;

  showLineNumbers.value = true;

  await nextTick();
  const el = contentRef.value?.querySelector(`[data-line="${props.initialLine}"]`) as HTMLElement | null;
  if (!el) return;

  const scrollContainer = contentRef.value;
  if (!scrollContainer) return;
  const lineTop = el.offsetTop;
  const containerHeight = scrollContainer.clientHeight;
  scrollContainer.scrollTop = lineTop - containerHeight / 2;

  el.classList.add("line-highlight-flash");
});

function openInIDE() {
  if (isRemoteFile.value) return;
  const cmd = props.ideCommand || "code";
  const fullPath = `${props.worktreePath}/${props.filePath}`;
  invoke("run_script", {
    script: `${cmd} "${fullPath}"`,
    cwd: props.worktreePath,
    env: {},
  }).catch((e) => console.error("[openInIDE] failed:", e));
}

function handleSearchInputKeydown(e: KeyboardEvent) {
  handleInputKeys(e);
  if (e.key === "Enter") {
    nextTick(() => modalRef.value?.focus());
  }
}

useLessScroll(contentRef, {
  isActive: isForeground,
  extraHandler(e) {
    const isSearchFocusKey =
      (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "/") ||
      ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "f");

    // Search keys first (disabled in rendered markdown mode)
    if (!(renderMarkdown.value && isMarkdownFile.value) && handleSearchKeys(e)) {
      if (isSearchFocusKey) {
        nextTick(() => searchInputRef.value?.focus());
      }
      return true;
    }

    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "o") {
      e.preventDefault();
      openInIDE();
      return true;
    }
    if (
      e.key === "l" &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    ) {
      e.preventDefault();
      showLineNumbers.value = !showLineNumbers.value;
      return true;
    }
    if (
      e.key === "m" &&
      isMarkdownFile.value &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    ) {
      e.preventDefault();
      if (isSearching.value) closeSearch();
      toggleMarkdownMode();
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

/** Layered dismiss: close search first, then close modal. */
function dismiss(): boolean {
  if (isSearching.value) {
    closeSearch();
    return false;
  }

  return true;
}

defineExpose({ zIndex, bringToFront, dismiss });

onMounted(() => {
  loadFile();
  if (!isForeground()) return;
  nextTick(() => modalRef.value?.focus());
});

// An embedded preview stays mounted behind other tabs, so it takes focus when
// it becomes the active one rather than only on mount.
watch(
  () => props.active,
  (active) => {
    if (!props.embedded || !active) return;
    nextTick(() => modalRef.value?.focus());
  },
);
</script>

<template>
  <div
    class="modal-overlay"
    :class="[{ maximized, standalone }, overlayClass]"
    :style="overlayStyle"
    @click.self="dismissOnScrimClick(() => emit('close'))"
  >
    <div ref="modalRef" class="preview-modal" tabindex="-1">
      <div class="preview-header">
        <span class="file-path">{{ filePath }}</span>
        <div class="header-actions">
          <span v-if="isMarkdownFile" class="mode-badge" @click="toggleMarkdownMode" title="m">
            {{ renderMarkdown ? $t('filePreview.rendered') : $t('filePreview.raw') }}
          </span>
          <button v-if="!isRemoteFile" class="btn-open" @click="openInIDE" :title="$t('filePreview.openInIDETooltip')">{{ $t('filePreview.openInIDE') }}</button>
        </div>
      </div>
      <div v-if="loading" class="preview-status">{{ $t('common.loading') }}</div>
      <div v-else-if="error" class="preview-status preview-error" role="alert" data-testid="file-preview-unavailable">
        Task file unavailable: {{ error }}
      </div>
      <div
        v-else
        ref="contentRef"
        class="preview-content"
        :class="{ 'markdown-rendered': renderMarkdown && isMarkdownFile, 'with-line-numbers': showLineNumbers && !renderMarkdown }"
      >
        <template v-if="showLineNumbers && !renderMarkdown">
          <div class="line-numbers-gutter">
            <div v-for="i in lineCount" :key="i" class="line-number">{{ i }}</div>
          </div>
          <div class="code-column" v-html="highlighted"></div>
        </template>
        <template v-else>
          <div v-html="renderMarkdown && isMarkdownFile ? renderedMarkdown : highlighted"></div>
        </template>
      </div>
      <!-- Search bar (vim/less style, bottom of modal) -->
      <div v-if="isSearching" class="search-bar">
        <span class="search-prefix">/</span>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          v-bind="macOsTextInputAttrs"
          class="search-input"
          :placeholder="$t('filePreview.searchPlaceholder')"
          @keydown="handleSearchInputKeydown"
        />
        <span v-if="searchQuery" class="search-count">
          {{ searchMatchCount > 0
            ? `${searchCurrentMatch}/${searchMatchCount}`
            : $t('filePreview.searchNoMatches') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--kn-overlay-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
  position: relative;
}

.modal-overlay.standalone {
  background: none;
}

.modal-overlay.embedded {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 0;
  background: none;
}

.standalone .preview-modal,
.embedded .preview-modal {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-sidebar);
  flex-shrink: 0;
}

.file-path {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--kn-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.btn-open {
  padding: 3px 10px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-muted);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-open:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.mode-badge {
  padding: 2px 8px;
  background: var(--kn-bg-hover);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-muted);
  font-size: 11px;
  font-family: "SF Mono", Menlo, monospace;
  cursor: pointer;
  user-select: none;
}

.mode-badge:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-secondary);
}

/* Rendered markdown styles */
.markdown-rendered {
  padding: 24px 32px;
  color: var(--kn-text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}

.markdown-rendered :deep(h1),
.markdown-rendered :deep(h2),
.markdown-rendered :deep(h3),
.markdown-rendered :deep(h4),
.markdown-rendered :deep(h5),
.markdown-rendered :deep(h6) {
  color: var(--kn-text-primary);
  margin: 24px 0 12px;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-rendered :deep(h1) { font-size: 1.8em; padding-bottom: 8px; border-bottom: 1px solid var(--kn-border-default); }
.markdown-rendered :deep(h2) { font-size: 1.4em; padding-bottom: 6px; border-bottom: 1px solid var(--kn-border-default); }
.markdown-rendered :deep(h3) { font-size: 1.2em; }
.markdown-rendered :deep(h4) { font-size: 1.1em; }
.markdown-rendered :deep(h5) { font-size: 1em; }
.markdown-rendered :deep(h6) { font-size: 0.9em; color: var(--kn-text-muted); }

.markdown-rendered :deep(p) {
  margin: 0 0 12px;
}

.markdown-rendered :deep(a) {
  color: var(--kn-accent);
  text-decoration: none;
}

.markdown-rendered :deep(a:hover) {
  text-decoration: underline;
}

.markdown-rendered :deep(strong) {
  color: var(--kn-text-primary);
  font-weight: 600;
}

.markdown-rendered :deep(blockquote) {
  margin: 0 0 12px;
  padding: 4px 16px;
  border-left: 3px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
}

.markdown-rendered :deep(blockquote p) {
  margin: 0;
}

.markdown-rendered :deep(ul),
.markdown-rendered :deep(ol) {
  margin: 0 0 12px;
  padding-left: 24px;
}

.markdown-rendered :deep(li) {
  margin: 4px 0;
}

.markdown-rendered :deep(li > ul),
.markdown-rendered :deep(li > ol) {
  margin: 4px 0 0;
}

/* Task list checkboxes */
.markdown-rendered :deep(.task-list-item) {
  list-style: none;
  margin-left: -24px;
  padding-left: 24px;
}

.markdown-rendered :deep(.task-list-item input[type="checkbox"]) {
  margin-right: 8px;
  pointer-events: none;
}

.markdown-rendered :deep(hr) {
  border: none;
  border-top: 1px solid var(--kn-border-default);
  margin: 24px 0;
}

/* Code blocks (Shiki-highlighted) */
.markdown-rendered :deep(pre) {
  margin: 0 0 12px;
  padding: 12px 16px;
  background: var(--kn-code-bg) !important;
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-rendered :deep(pre code) {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 13px;
  background: none;
  padding: 0;
  border-radius: 0;
}

/* Inline code */
.markdown-rendered :deep(code) {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 0.9em;
  background: var(--kn-bg-panel-raised);
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--kn-text-primary);
}

/* Tables */
.markdown-rendered :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 12px;
}

.markdown-rendered :deep(th),
.markdown-rendered :deep(td) {
  border: 1px solid var(--kn-border-default);
  padding: 8px 12px;
  text-align: left;
}

.markdown-rendered :deep(th) {
  background: var(--kn-bg-panel);
  font-weight: 600;
}

.markdown-rendered :deep(tr:nth-child(even)) {
  background: var(--kn-bg-sidebar);
}

/* Images */
.markdown-rendered :deep(img) {
  max-width: 100%;
}

/* Strikethrough */
.markdown-rendered :deep(del) {
  color: var(--kn-text-muted);
}

.preview-status {
  padding: 24px;
  color: var(--kn-text-muted);
  text-align: center;
  font-size: 13px;
}

.preview-error {
  color: var(--kn-danger);
}

.preview-content {
  flex: 1;
  overflow: auto;
  font-size: 13px;
  line-height: 1.5;
}

.preview-content:not(.markdown-rendered) :deep(pre) {
  margin: 0;
  padding: 12px 16px;
  background: var(--kn-code-bg) !important;
  min-height: 100%;
}

.preview-content:not(.markdown-rendered) :deep(code) {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 13px;
}

/* Line numbers grid layout */
.preview-content.with-line-numbers {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0;
}

.line-numbers-gutter {
  display: flex;
  flex-direction: column;
  background: var(--kn-bg-app);
  border-right: 1px solid var(--kn-border-default);
  padding: 12px 8px;
  user-select: none;
  line-height: 1.5;
}

.line-number {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 13px;
  color: var(--kn-text-muted);
  text-align: right;
  min-width: 2em;
  padding-right: 8px;
  height: 1.5em;
}

.code-column {
  overflow-x: auto;
}

.preview-content.with-line-numbers :deep(pre) {
  margin: 0;
  padding: 12px 16px;
  background: var(--kn-code-bg) !important;
  min-height: 100%;
}

/* Search bar */
.search-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--kn-bg-sidebar);
  border-top: 1px solid var(--kn-border-default);
  border-radius: 0 0 8px 8px;
  z-index: 10;
}

.search-prefix {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--kn-text-muted);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--kn-text-primary);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.search-count {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: var(--kn-text-muted);
  flex-shrink: 0;
}

/* Search highlight styles (inside v-html, needs :deep) */
.preview-content :deep(.search-hl) {
  background: rgba(255, 200, 0, 0.25);
  border-radius: 2px;
}

.preview-content :deep(.search-hl-active) {
  background: rgba(255, 200, 0, 0.55);
  border-radius: 2px;
  outline: 1px solid rgba(255, 200, 0, 0.8);
}

:deep(.line-highlight-flash) {
  animation: line-flash 1.5s ease-out;
}

@keyframes line-flash {
  0% { background-color: rgba(255, 255, 150, 0.15); }
  100% { background-color: transparent; }
}

.maximized { background: none; }
.maximized .preview-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}
</style>
