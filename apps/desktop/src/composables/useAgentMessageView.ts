import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import MarkdownIt from "markdown-it";
import type { AgentEvent, PermissionDecision, TurnStats } from "@kanna/agent-protocol";
import { getActivePinia } from "pinia";
import type { BundledLanguage } from "shiki";
import type { AgentProvider } from "@kanna/db";
import { agentModelsFor } from "@kanna/core";
import { useAgentStream } from "./useAgentStream";
import { useSlashCommands, type SlashCommand } from "./useSlashCommands";
import { useKannaStore } from "../stores/kanna";
import type { AgentMessageAppearance } from "../stores/state";
import { getShikiTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";

type ShikiTheme = ReturnType<typeof getShikiTheme>;

interface MarkdownHighlighter {
  loadLanguage: (language: BundledLanguage) => Promise<void>;
  getLoadedLanguages: () => string[];
  codeToHtml: (code: string, options: { lang: BundledLanguage | "text"; theme: ShikiTheme }) => string;
}

export interface UseAgentMessageViewProps {
  sessionId: string;
  agentProvider?: AgentProvider;
  worktreePath?: string;
  recoverSession?: (sessionId: string) => Promise<void>;
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const IMAGE_LINK_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

// Tool calls ("shell"), tool results, and raw/diagnostic debug output are the
// agent's internal plumbing — hidden so the view reads like a Claude/ChatGPT
// conversation of user + assistant messages.
const HIDDEN_EVENT_TYPES = new Set<string>([
  "raw",
  "diagnostic",
  "permission_resolved",
  "tool_call",
  "tool_result",
]);

const SLASH_MENU_LIMIT = 8;

function normalizeAppearance(value: string | null | undefined): AgentMessageAppearance {
  if (value === "log" || value === "terminal") return value;
  return "chat";
}

function isImageLinkHref(href: string | null): href is string {
  return Boolean(href && IMAGE_LINK_EXTENSION.test(href));
}

function renderImageLinkPreviews(html: string): string {
  if (typeof document === "undefined") return html;

  const template = document.createElement("template");
  template.innerHTML = html;

  for (const anchor of Array.from(template.content.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!isImageLinkHref(href)) continue;

    const label = anchor.textContent?.trim() || href;
    const preview = document.createElement("span");
    preview.className = "agent-image-link-preview";

    const imageLink = document.createElement("a");
    imageLink.className = "agent-image-link-preview-media";
    imageLink.href = href;

    const image = document.createElement("img");
    image.src = href;
    image.alt = label;
    image.loading = "lazy";
    image.decoding = "async";
    imageLink.append(image);

    const caption = document.createElement("a");
    caption.className = "agent-image-link-preview-caption";
    caption.href = href;
    caption.textContent = label;

    preview.append(imageLink, caption);
    anchor.replaceWith(preview);
  }

  return template.innerHTML;
}

export function useAgentMessageView(props: UseAgentMessageViewProps) {
  const store = getActivePinia() ? useKannaStore() : null;
  const themeRuntime = useThemeRuntime();
  const shikiTheme = computed(() => getShikiTheme(themeRuntime.effectiveCodeTheme.value));
  // Resolved app theme as a local class so skins (e.g. terminal) can follow
  // light/dark without depending on an ancestor `data-theme` selector.
  const appTheme = computed(() => themeRuntime.effectiveAppTheme.value);
  const composer = ref("");
  const composerEl = ref<HTMLTextAreaElement | null>(null);
  const denyReasons = ref<Record<string, string>>({});
  const scrollContainer = ref<HTMLElement | null>(null);
  const appearance = ref<AgentMessageAppearance>(normalizeAppearance(store?.agentMessageAppearance ?? null));
  const renderedAssistant = ref<Record<number, string>>({});
  const stream = useAgentStream(props.sessionId, {
    recoverSession: props.recoverSession,
  });
  let highlighterPromise: Promise<MarkdownHighlighter> | null = null;
  let focusRetryTimer: number | null = null;

  const displayEvents = computed(() =>
    stream.events.value.filter((item) => !HIDDEN_EVENT_TYPES.has(item.event.type)),
  );
  const isRunning = computed(() => {
    for (let i = stream.events.value.length - 1; i >= 0; i -= 1) {
      const type = stream.events.value[i].event.type;
      if (type === "turn_started") return true;
      if (type === "turn_completed" || type === "session_ended") return false;
    }
    return false;
  });
  const isEmpty = computed(() => displayEvents.value.length === 0 && !stream.error.value);

  watch(() => store?.agentMessageAppearance, (nextAppearance) => {
    if (nextAppearance) appearance.value = normalizeAppearance(nextAppearance);
  });

  watch([() => stream.events.value, shikiTheme], () => {
    void refreshRenderedMarkdown();
  }, { immediate: true });

  watch(() => stream.events.value.length, async () => {
    await nextTick();
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
    }
  });

  function fallbackMarkdown(text: string): string {
    return renderImageLinkPreviews(markdown.render(text));
  }

  async function getMarkdownHighlighter(): Promise<MarkdownHighlighter> {
    if (!highlighterPromise) {
      highlighterPromise = import("shiki").then(async ({ createHighlighter }) =>
        createHighlighter({ themes: ["github-dark", "github-light"], langs: ["text"] }) as Promise<MarkdownHighlighter>
      );
    }
    return highlighterPromise;
  }

  function extractFenceLanguages(text: string): string[] {
    const languages = new Set<string>();
    for (const match of text.matchAll(/```([A-Za-z0-9_+-]+)/g)) {
      languages.add(match[1].toLowerCase());
    }
    return [...languages];
  }

  async function loadFenceLanguages(highlighter: MarkdownHighlighter, text: string): Promise<void> {
    for (const language of extractFenceLanguages(text)) {
      const candidate = language as BundledLanguage;
      if (highlighter.getLoadedLanguages().includes(candidate)) continue;
      await highlighter.loadLanguage(candidate).catch(() => undefined);
    }
  }

  function resolveLoadedLanguage(highlighter: MarkdownHighlighter, language: string): BundledLanguage | "text" {
    const candidate = language.toLowerCase() as BundledLanguage;
    return highlighter.getLoadedLanguages().includes(candidate) ? candidate : "text";
  }

  async function renderMarkdownWithShiki(text: string): Promise<string> {
    const highlighter = await getMarkdownHighlighter();
    await loadFenceLanguages(highlighter, text);
    const renderer = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      highlight: (code, language) =>
        highlighter.codeToHtml(code, {
          lang: language ? resolveLoadedLanguage(highlighter, language) : "text",
          theme: shikiTheme.value,
        }),
    });
    return renderImageLinkPreviews(renderer.render(text));
  }

  async function refreshRenderedMarkdown(): Promise<void> {
    const assistantEvents = stream.events.value.filter(
      (item): item is typeof item & { event: Extract<AgentEvent, { type: "assistant_text" }> } =>
        item.event.type === "assistant_text",
    );
    const nextRendered: Record<number, string> = {};
    await Promise.all(assistantEvents.map(async (item) => {
      nextRendered[item.seq] = await renderMarkdownWithShiki(item.event.text).catch(() => fallbackMarkdown(item.event.text));
    }));
    renderedAssistant.value = nextRendered;
  }

  function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolTitle(event: Extract<AgentEvent, { type: "tool_call" | "permission_request" }>): string {
    if (event.tool_name === "Bash") return "Bash";
    if (event.tool_name === "Edit") return "Edit";
    if (event.tool_name === "Write") return "Write";
    if (event.tool_name === "Read") return "Read";
    return event.tool_name;
  }

  function adjustComposerHeight() {
    const el = composerEl.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function onComposerInput() {
    void nextTick(adjustComposerHeight);
  }

  function focusComposer() {
    void nextTick(() => composerEl.value?.focus());
  }

  function clearFocusRetry() {
    if (focusRetryTimer === null) return;
    window.clearTimeout(focusRetryTimer);
    focusRetryTimer = null;
  }

  function focusComposerAfterSelection(attempt = 0) {
    void nextTick(() => {
      adjustComposerHeight();
      if (document.querySelector(".modal-overlay")) {
        if (attempt < 20) {
          clearFocusRetry();
          focusRetryTimer = window.setTimeout(() => focusComposerAfterSelection(attempt + 1), 50);
        }
        return;
      }
      composerEl.value?.focus();
    });
  }

  function handleRenderedMessageClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest(".agent-image-link-preview a[href]");
    if (!link) return;

    const imageUrl = link.getAttribute("href");
    if (!isImageLinkHref(imageUrl)) return;

    event.preventDefault();
    document.dispatchEvent(new CustomEvent("image-link-activate", {
      detail: { url: imageUrl },
    }));
  }

  onMounted(() => {
    focusComposerAfterSelection();
  });

  onUnmounted(() => {
    clearFocusRetry();
  });

  // ── Slash commands ──────────────────────────────────────────
  const slashProvider = computed<string | undefined>(() => props.agentProvider);
  const slashWorktree = computed<string | undefined>(() => props.worktreePath);
  const slash = useSlashCommands(slashProvider, slashWorktree);
  const slashIndex = ref(0);
  const slashDismissed = ref(false);

  // The menu is active while the line is a single `/token` with no arguments yet.
  const slashQuery = computed<string | null>(() => {
    const match = composer.value.match(/^\/(\S*)$/);
    return match ? match[1] : null;
  });
  const slashMatches = computed<SlashCommand[]>(() =>
    slashQuery.value === null ? [] : slash.filter(slashQuery.value).slice(0, SLASH_MENU_LIMIT),
  );
  const slashMenuOpen = computed(
    () => !slashDismissed.value && slashQuery.value !== null && slashMatches.value.length > 0,
  );

  watch(slashQuery, (query) => {
    slashIndex.value = 0;
    if (query !== null) slashDismissed.value = false;
  });
  watch(slashMatches, (matches) => {
    if (slashIndex.value >= matches.length) slashIndex.value = Math.max(0, matches.length - 1);
  });

  function applySlashCommand(command: SlashCommand) {
    composer.value = `/${command.name} `;
    slashDismissed.value = true;
    composerEl.value?.focus();
    void nextTick(adjustComposerHeight);
  }

  // ── Model selection ─────────────────────────────────────────
  const modelOptions = computed(() => agentModelsFor(props.agentProvider));
  // The first option is the best/default model for the provider.
  const bestModel = computed(() => modelOptions.value[0]?.id ?? "");
  // Reflect the running model from the latest turn when it matches a known option.
  const activeModel = computed(() => {
    for (let i = stream.events.value.length - 1; i >= 0; i -= 1) {
      const event = stream.events.value[i].event;
      if (event.type === "turn_started" && event.model) {
        const match = modelOptions.value.find((option) => event.model?.startsWith(option.id));
        if (match) return match.id;
      }
    }
    return "";
  });
  const selectedModel = ref("");
  const userPickedModel = ref(false);
  // Default to the best model, fall back to reflecting the running model, and
  // stop overriding once the user makes a choice.
  watchEffect(() => {
    if (userPickedModel.value) return;
    selectedModel.value = activeModel.value || bestModel.value;
  });

  function onModelChange() {
    userPickedModel.value = true;
    if (selectedModel.value) stream.setModel(selectedModel.value);
  }

  function sendComposer() {
    const text = composer.value.trim();
    if (!text || !stream.ready.value) return;
    stream.sendInput(text);
    composer.value = "";
    slashDismissed.value = false;
    void nextTick(adjustComposerHeight);
    focusComposer();
  }

  function interruptAgent() {
    stream.interrupt();
    focusComposer();
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;

    if (slashMenuOpen.value) {
      const key = event.key.toLowerCase();
      const goDown = event.key === "ArrowDown" || (event.ctrlKey && key === "n");
      const goUp = event.key === "ArrowUp" || (event.ctrlKey && key === "p");
      if (goDown) {
        event.preventDefault();
        slashIndex.value = (slashIndex.value + 1) % slashMatches.value.length;
        return;
      }
      if (goUp) {
        event.preventDefault();
        slashIndex.value = (slashIndex.value - 1 + slashMatches.value.length) % slashMatches.value.length;
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = slashMatches.value[slashIndex.value];
        if (selected) applySlashCommand(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slashDismissed.value = true;
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendComposer();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      interruptAgent();
    }
  }

  function resolvePermission(requestId: string, decision: PermissionDecision) {
    stream.sendPermission(requestId, decision);
  }

  function statsLabel(stats: TurnStats | null): string {
    if (!stats) return "";
    const parts = [`${stats.num_turns} turns`, `${(stats.duration_ms / 1000).toFixed(1)}s`];
    if (stats.total_cost_usd !== null && stats.total_cost_usd !== undefined) {
      parts.push(`$${stats.total_cost_usd.toFixed(4)}`);
    }
    if (stats.input_tokens || stats.output_tokens) {
      parts.push(`${stats.input_tokens ?? 0}/${stats.output_tokens ?? 0} tok`);
    }
    return parts.join(" · ");
  }

  function sessionEndedLabel(event: Extract<AgentEvent, { type: "session_ended" }>): string {
    // "Interrupted" is a user-initiated stop, not the session dying — keep it
    // light and avoid implying the session is over.
    const base = event.reason === "interrupted" ? "Stopped" : `Session ${event.reason}`;
    return event.message ? `${base} · ${event.message}` : base;
  }

  return {
    appTheme,
    appearance,
    composer,
    composerEl,
    denyReasons,
    displayEvents,
    fallbackMarkdown,
    formatValue,
    handleComposerKeydown,
    handleRenderedMessageClick,
    interruptAgent,
    isEmpty,
    isRunning,
    modelOptions,
    onComposerInput,
    onModelChange,
    renderedAssistant,
    resolvePermission,
    scrollContainer,
    selectedModel,
    sendComposer,
    sessionEndedLabel,
    slashIndex,
    slashMatches,
    slashMenuOpen,
    applySlashCommand,
    statsLabel,
    stream,
    toolTitle,
  };
}
