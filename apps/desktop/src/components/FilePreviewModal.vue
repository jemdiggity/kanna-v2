<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted } from "vue";
import { invoke } from "../invoke";

const props = defineProps<{
  filePath: string;
  worktreePath: string;
  ideCommand?: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const content = ref("");
const highlighted = ref("");
const loading = ref(true);
const error = ref<string | null>(null);

const renderMarkdown = ref(false);

const isMarkdownFile = computed(() =>
  props.filePath.toLowerCase().endsWith(".md")
);

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
      if (!lang) return "";
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
  }).catch(() => {});
}

function handleKeydown(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === "o") {
    e.preventDefault();
    openInIDE();
    return;
  }
  if (
    e.key === " " &&
    isMarkdownFile.value &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    e.preventDefault();
    renderMarkdown.value = !renderMarkdown.value;
  }
}

onMounted(() => {
  loadFile();
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="preview-modal">
      <div class="preview-header">
        <span class="file-path">{{ filePath }}</span>
        <div class="header-actions">
          <span v-if="isMarkdownFile" class="mode-badge" @click="renderMarkdown = !renderMarkdown">
            {{ renderMarkdown ? "Rendered" : "Raw" }}
            <span class="mode-hint">␣</span>
          </span>
          <button class="btn-open" @click="openInIDE" title="Open in IDE (⌘O)">Open in IDE</button>
        </div>
      </div>
      <div v-if="loading" class="preview-status">Loading...</div>
      <div v-else-if="error" class="preview-status preview-error">{{ error }}</div>
      <div
        v-else
        class="preview-content"
        :class="{ 'markdown-rendered': renderMarkdown && isMarkdownFile }"
        v-html="renderMarkdown && isMarkdownFile ? renderedMarkdown : highlighted"
      ></div>
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

.preview-content :deep(pre) {
  margin: 0;
  padding: 12px 16px;
  background: #1a1a1a !important;
  min-height: 100%;
}

.preview-content :deep(code) {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 13px;
}
</style>
