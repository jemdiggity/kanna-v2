<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { invoke } from "../invoke";
import { useLessScroll } from "../composables/useLessScroll";
import { useShortcutContext, registerContextShortcuts } from "../composables/useShortcutContext";

const props = defineProps<{
  filePath: string;
  worktreePath: string;
  ideCommand?: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const contentRef = ref<HTMLElement | null>(null);
const modalRef = ref<HTMLElement | null>(null);

useShortcutContext("file");
const showLineNumbers = ref(false);
registerContextShortcuts("file", [
  { label: "Open in IDE", display: "⌘O" },
  { label: "Toggle Line Numbers", display: "l" },
  ...(props.filePath.toLowerCase().endsWith(".md")
    ? [{ label: "Toggle Markdown", display: "m" }]
    : []),
  { label: "Line ↓/↑", display: "j / k" },
  { label: "Page ↓/↑", display: "f / b" },
  { label: "Half ↓/↑", display: "d / u" },
  { label: "Top / Bottom", display: "g / G" },
  { label: "Close", display: "q" },
]);
const content = ref("");
const highlighted = ref("");
const loading = ref(true);
const error = ref<string | null>(null);

const renderMarkdown = ref(false);

const isMarkdownFile = computed(() =>
  props.filePath.toLowerCase().endsWith(".md")
);

const lineCount = computed(() => {
  if (!content.value) return 0;
  return content.value.split('\n').length;
});

// Lazy-load shiki to avoid blocking startup
let highlighter: any = null;

async function getHighlighter() {
  if (highlighter) return highlighter;
  const { createHighlighter } = await import("shiki");
  highlighter = await createHighlighter({
    themes: ["github-dark"],
    langs: [],
  });
  return highlighter;
}

// Lazy-load markdown-it to avoid blocking startup
let md: any = null;

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
      if (!lang) return hl.codeToHtml(str, { lang: "text", theme: "github-dark" });
      // Languages are pre-loaded in the watcher before md.render() is called,
      // so getLoadedLanguages() is reliable here (no async needed).
      const loaded = hl.getLoadedLanguages();
      const useLang = loaded.includes(lang) ? lang : "text";
      return hl.codeToHtml(str, { lang: useLang, theme: "github-dark" });
    },
  });
  md.use(taskLists, { enabled: false });
  md.use(strikethrough);
  return md;
}

const renderedMarkdown = ref("");

watch([renderMarkdown, content], async ([shouldRender, raw]) => {
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
    langs.map((lang) => hl.loadLanguage(lang).catch(() => {}))
  );

  renderedMarkdown.value = parser.render(raw);
});

function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    vue: "vue", html: "html", css: "css", scss: "scss",
    json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
    md: "markdown", rs: "rust", py: "python", rb: "ruby",
    go: "go", sh: "bash", zsh: "bash", bash: "bash",
    sql: "sql", swift: "swift", kt: "kotlin", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    xml: "xml", svg: "xml", graphql: "graphql",
  };
  return map[ext] || "text";
}

async function loadFile() {
  loading.value = true;
  error.value = null;
  renderMarkdown.value = false;
  try {
    const fullPath = `${props.worktreePath}/${props.filePath}`;
    content.value = await invoke<string>("read_text_file", { path: fullPath });

    const hl = await getHighlighter();
    const lang = langFromPath(props.filePath);

    // Load language if not already loaded
    try {
      await hl.loadLanguage(lang);
    } catch {
      // Language not available — fall back to text
    }

    const loadedLangs = hl.getLoadedLanguages();
    const useLang = loadedLangs.includes(lang) ? lang : "text";

    highlighted.value = hl.codeToHtml(content.value, {
      lang: useLang,
      theme: "github-dark",
      transformers: [{
        pre(node: any) {
          node.properties.style = "white-space:pre-wrap;word-wrap:break-word;";
        },
      }],
    });
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function openInIDE() {
  const cmd = props.ideCommand || "code";
  const fullPath = `${props.worktreePath}/${props.filePath}`;
  invoke("run_script", {
    script: `${cmd} "${fullPath}"`,
    cwd: props.worktreePath,
    env: {},
  }).catch((e) => console.error("[openInIDE] failed:", e));
}

useLessScroll(contentRef, {
  extraHandler(e) {
    const meta = e.metaKey || e.ctrlKey;
    // Cmd+O — open in IDE
    if (meta && e.key === "o") {
      e.preventDefault();
      openInIDE();
      return true;
    }
    // l — toggle line numbers
    if (
      e.key === "l" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      showLineNumbers.value = !showLineNumbers.value;
      return true;
    }
    // m — toggle markdown rendering
    if (
      e.key === "m" &&
      isMarkdownFile.value &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      renderMarkdown.value = !renderMarkdown.value;
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

onMounted(() => {
  loadFile();
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div ref="modalRef" class="preview-modal" tabindex="-1">
      <div class="preview-header">
        <span class="file-path">{{ filePath }}</span>
        <div class="header-actions">
          <span v-if="isMarkdownFile" class="mode-badge" @click="renderMarkdown = !renderMarkdown" title="m">
            {{ renderMarkdown ? "Rendered" : "Raw" }}
          </span>
          <button class="btn-open" @click="openInIDE" title="Open in IDE (⌘O)">Open in IDE</button>
        </div>
      </div>
      <div v-if="loading" class="preview-status">Loading...</div>
      <div v-else-if="error" class="preview-status preview-error">{{ error }}</div>
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
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.preview-modal {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid #333;
  background: #1e1e1e;
  flex-shrink: 0;
}

.file-path {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #ccc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.btn-open {
  padding: 3px 10px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #aaa;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-open:hover {
  background: #333;
  color: #fff;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.mode-badge {
  padding: 2px 8px;
  background: #333;
  border: 1px solid #444;
  border-radius: 4px;
  color: #aaa;
  font-size: 11px;
  font-family: "SF Mono", Menlo, monospace;
  cursor: pointer;
  user-select: none;
}

.mode-badge:hover {
  background: #3a3a3a;
  color: #ccc;
}

/* Rendered markdown styles */
.markdown-rendered {
  padding: 24px 32px;
  color: #e0e0e0;
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
  color: #e0e0e0;
  margin: 24px 0 12px;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-rendered :deep(h1) { font-size: 1.8em; padding-bottom: 8px; border-bottom: 1px solid #333; }
.markdown-rendered :deep(h2) { font-size: 1.4em; padding-bottom: 6px; border-bottom: 1px solid #333; }
.markdown-rendered :deep(h3) { font-size: 1.2em; }
.markdown-rendered :deep(h4) { font-size: 1.1em; }
.markdown-rendered :deep(h5) { font-size: 1em; }
.markdown-rendered :deep(h6) { font-size: 0.9em; color: #aaa; }

.markdown-rendered :deep(p) {
  margin: 0 0 12px;
}

.markdown-rendered :deep(a) {
  color: #58a6ff;
  text-decoration: none;
}

.markdown-rendered :deep(a:hover) {
  text-decoration: underline;
}

.markdown-rendered :deep(strong) {
  color: #f0f0f0;
  font-weight: 600;
}

.markdown-rendered :deep(blockquote) {
  margin: 0 0 12px;
  padding: 4px 16px;
  border-left: 3px solid #444;
  color: #aaa;
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
  border-top: 1px solid #333;
  margin: 24px 0;
}

/* Code blocks (Shiki-highlighted) */
.markdown-rendered :deep(pre) {
  margin: 0 0 12px;
  padding: 12px 16px;
  background: #252525 !important;
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
  background: #2a2a2a;
  padding: 2px 6px;
  border-radius: 3px;
  color: #e0e0e0;
}

/* Tables */
.markdown-rendered :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 12px;
}

.markdown-rendered :deep(th),
.markdown-rendered :deep(td) {
  border: 1px solid #333;
  padding: 8px 12px;
  text-align: left;
}

.markdown-rendered :deep(th) {
  background: #252525;
  font-weight: 600;
}

.markdown-rendered :deep(tr:nth-child(even)) {
  background: #1e1e1e;
}

/* Images */
.markdown-rendered :deep(img) {
  max-width: 100%;
}

/* Strikethrough */
.markdown-rendered :deep(del) {
  color: #666;
}

.preview-status {
  padding: 24px;
  color: #666;
  text-align: center;
  font-size: 13px;
}

.preview-error {
  color: #f85149;
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
  background: #1a1a1a !important;
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
  background: #0f0f0f;
  border-right: 1px solid #333;
  padding: 12px 8px;
  user-select: none;
  line-height: 1.5;
}

.line-number {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 13px;
  color: #555;
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
  background: #1a1a1a !important;
  min-height: 100%;
}
</style>
