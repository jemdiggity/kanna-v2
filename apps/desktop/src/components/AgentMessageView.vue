<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import MarkdownIt from "markdown-it";
import type { AgentEvent, PermissionDecision, TurnStats } from "@kanna/agent-protocol";
import { getActivePinia } from "pinia";
import type { BundledLanguage } from "shiki";
import type { AgentProvider } from "@kanna/db";
import { agentModelsFor } from "@kanna/core";
import { useAgentStream } from "../composables/useAgentStream";
import { useSlashCommands, type SlashCommand } from "../composables/useSlashCommands";
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

const props = defineProps<{
  sessionId: string;
  agentProvider?: AgentProvider;
  worktreePath?: string;
  recoverSession?: (sessionId: string) => Promise<void>;
}>();

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
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
let focusRetryTimer: ReturnType<typeof window.setTimeout> | null = null;

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

function normalizeAppearance(value: string | null | undefined): AgentMessageAppearance {
  if (value === "log" || value === "terminal") return value;
  return "chat";
}

function fallbackMarkdown(text: string): string {
  return markdown.render(text);
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
  return renderer.render(text);
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
const SLASH_MENU_LIMIT = 8;

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
</script>

<template>
  <section class="agent-message-view" :class="[`skin-${appearance}`, `theme-${appTheme}`]">
    <div ref="scrollContainer" class="agent-scroll" data-testid="agent-message-view">
      <div class="conversation">
        <div v-if="isEmpty" class="empty-state">
          <p class="empty-title">Ready when you are</p>
          <p class="empty-hint">Send a message to start working with the agent.</p>
        </div>

        <article
          v-for="item in displayEvents"
          :key="item.seq"
          class="event"
          :class="`event-${item.event.type}`"
        >
          <template v-if="item.event.type === 'turn_started'">
            <div class="event-label">Started{{ item.event.model ? ` · ${item.event.model}` : "" }}</div>
          </template>

          <template v-else-if="item.event.type === 'user_message'">
            <div class="row row-user">
              <div class="message user">{{ item.event.text }}</div>
            </div>
          </template>

          <template v-else-if="item.event.type === 'assistant_text'">
            <div class="row row-assistant">
              <div class="message assistant" v-html="renderedAssistant[item.seq] ?? fallbackMarkdown(item.event.text)" />
            </div>
          </template>

          <template v-else-if="item.event.type === 'thinking'">
            <details class="thinking">
              <summary><span class="caret" />Thought process</summary>
              <pre>{{ item.event.text }}</pre>
            </details>
          </template>

          <template v-else-if="item.event.type === 'tool_progress'">
            <div class="event-label">{{ item.event.message }}</div>
          </template>

          <template v-else-if="item.event.type === 'permission_request'">
            <div class="permission-card" :data-testid="`permission-${item.event.request_id}`">
              <div class="permission-title">Allow {{ toolTitle(item.event) }}?</div>
              <pre>{{ formatValue(item.event.input) }}</pre>
              <input
                v-model="denyReasons[item.event.request_id]"
                class="deny-reason"
                placeholder="Reason for denial (optional)"
                :data-testid="`permission-reason-${item.event.request_id}`"
              />
              <div class="permission-actions">
                <button type="button" class="primary" @click="resolvePermission(item.event.request_id, { kind: 'allow' })">Allow</button>
                <button type="button" @click="resolvePermission(item.event.request_id, { kind: 'allow_session' })">Allow for session</button>
                <button
                  type="button"
                  class="danger"
                  @click="resolvePermission(item.event.request_id, { kind: 'deny', reason: denyReasons[item.event.request_id] || null })"
                >
                  Deny
                </button>
              </div>
            </div>
          </template>

          <template v-else-if="item.event.type === 'turn_completed'">
            <div class="event-label">Turn {{ item.event.status }} · {{ statsLabel(item.event.stats) }}</div>
          </template>

          <template v-else-if="item.event.type === 'session_ended'">
            <div class="event-label">{{ sessionEndedLabel(item.event) }}</div>
          </template>
        </article>

        <div v-if="isRunning" class="typing-indicator" aria-label="Agent is working">
          <span /><span /><span />
        </div>

        <div v-if="stream.error.value" class="stream-error">{{ stream.error.value }}</div>
      </div>
    </div>

    <footer class="agent-footer">
      <div v-if="slashMenuOpen" class="slash-menu" data-testid="slash-menu">
        <button
          v-for="(command, index) in slashMatches"
          :key="`${command.source}:${command.name}`"
          type="button"
          class="slash-item"
          :class="{ active: index === slashIndex }"
          @mousedown.prevent="applySlashCommand(command)"
          @mouseenter="slashIndex = index"
        >
          <span class="slash-name">/{{ command.name }}</span>
          <span class="slash-desc">{{ command.description }}</span>
          <span class="slash-source">{{ command.source }}</span>
        </button>
      </div>
      <div class="composer-shell">
        <textarea
          ref="composerEl"
          v-model="composer"
          class="composer"
          rows="1"
          placeholder="Message the agent…"
          data-testid="agent-composer"
          @keydown="handleComposerKeydown"
          @input="onComposerInput"
        />
        <div class="composer-controls">
          <select
            v-if="modelOptions.length"
            v-model="selectedModel"
            class="model-select"
            data-testid="model-select"
            aria-label="Model"
            @change="onModelChange"
          >
            <option v-for="option in modelOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
          <button
            v-if="isRunning"
            type="button"
            class="composer-button stop-button"
            aria-label="Stop the agent"
            @mousedown.prevent
            @click="interruptAgent"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            type="button"
            class="composer-button send-button"
            aria-label="Send message"
            :disabled="!composer.trim() || !stream.ready.value"
            @mousedown.prevent
            @click="sendComposer"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M8 13V3M8 3l-4 4M8 3l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <p class="composer-hint">Enter to send · Shift+Enter for newline · Esc to interrupt</p>
    </footer>
  </section>
</template>

<style scoped>
.agent-message-view {
  --agent-bg: var(--kn-bg-app);
  --agent-panel: var(--kn-bg-panel);
  --agent-panel-raised: var(--kn-bg-panel-raised);
  --agent-border: var(--kn-border-default);
  --agent-text: var(--kn-text-primary);
  --agent-muted: var(--kn-text-muted);
  --agent-accent: var(--kn-accent);
  --agent-column: 760px;
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  background: var(--agent-bg);
  color: var(--agent-text);
}

/* ── Conversation ─────────────────────────────────────────── */
.agent-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.conversation {
  width: 100%;
  max-width: var(--agent-column);
  margin: 0 auto;
  padding: 24px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 14.5px;
  line-height: 1.62;
}

.event {
  margin: 0;
}

.row {
  display: flex;
}

.row-user {
  justify-content: flex-end;
}

.row-assistant {
  justify-content: flex-start;
}

/* ── Messages ─────────────────────────────────────────────── */
.message.user {
  max-width: 80%;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--kn-bg-accent-subtle);
  color: var(--agent-text);
  border-radius: 18px;
  border-bottom-right-radius: 6px;
  padding: 9px 14px;
}

.message.assistant {
  width: 100%;
  color: var(--agent-text);
}

.message.assistant :deep(p) {
  margin: 0 0 10px;
}

.message.assistant :deep(p:last-child) {
  margin-bottom: 0;
}

.message.assistant :deep(ul),
.message.assistant :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}

.message.assistant :deep(li) {
  margin: 2px 0;
}

.message.assistant :deep(h1),
.message.assistant :deep(h2),
.message.assistant :deep(h3) {
  margin: 16px 0 8px;
  line-height: 1.3;
}

.message.assistant :deep(a) {
  color: var(--agent-accent);
}

.message.assistant :deep(code) {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 0.86em;
  background: var(--kn-bg-accent-subtle);
  padding: 1px 5px;
  border-radius: 5px;
}

.message.assistant :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--agent-border);
  background: var(--kn-code-bg);
  overflow-x: auto;
}

.message.assistant :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.55;
}

/* ── Thinking (model reasoning) ───────────────────────────── */
.thinking {
  border: 1px solid var(--agent-border);
  border-radius: 10px;
  background: var(--agent-panel);
  overflow: hidden;
}

.thinking > summary {
  display: flex;
  align-items: center;
  gap: 7px;
  list-style: none;
  cursor: pointer;
  padding: 8px 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--agent-muted);
  user-select: none;
}

summary::-webkit-details-marker {
  display: none;
}

.caret {
  width: 6px;
  height: 6px;
  flex: none;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
}

details[open] > summary .caret {
  transform: rotate(45deg);
}

pre {
  margin: 0;
  padding: 0 12px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--agent-text);
}

.event-label {
  color: var(--agent-muted);
  font-size: 12px;
  text-align: center;
}

/* ── Permission request ───────────────────────────────────── */
.permission-card {
  border: 1px solid var(--agent-accent);
  border-radius: 12px;
  background: var(--kn-bg-accent-subtle);
  padding: 14px;
}

.permission-title {
  font-weight: 600;
  color: var(--agent-accent);
  margin-bottom: 8px;
}

.permission-card pre {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--kn-code-bg);
  border: 1px solid var(--agent-border);
}

.permission-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.deny-reason {
  width: 100%;
  margin-top: 10px;
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  background: var(--kn-bg-input);
  color: var(--agent-text);
  padding: 7px 10px;
  font: inherit;
}

.deny-reason:focus-visible {
  outline: none;
  border-color: var(--agent-accent);
}

/* ── Status affordances ───────────────────────────────────── */
.empty-state {
  margin: auto;
  text-align: center;
  color: var(--agent-muted);
  padding: 48px 0;
}

.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--agent-text);
  margin: 0 0 4px;
}

.empty-hint {
  margin: 0;
  font-size: 13px;
}

.typing-indicator {
  display: flex;
  gap: 5px;
  padding: 4px 2px;
}

.typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-muted);
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes typing-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-3px); }
}

.stream-error {
  color: var(--kn-danger);
  font-size: 13px;
  padding: 8px 12px;
  border: 1px solid var(--kn-danger);
  border-radius: 10px;
  background: var(--kn-danger-bg);
}

/* ── Composer ─────────────────────────────────────────────── */
.agent-footer {
  flex: none;
  padding: 8px 20px 14px;
  background: linear-gradient(to top, var(--agent-bg) 70%, transparent);
}

/* ── Slash command menu ───────────────────────────────────── */
.slash-menu {
  width: 100%;
  max-width: var(--agent-column);
  margin: 0 auto 8px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--agent-border);
  border-radius: 12px;
  background: var(--agent-panel);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 4px;
}

.slash-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: none;
  border-radius: 8px;
  background: transparent;
  padding: 7px 10px;
  cursor: pointer;
}

.slash-item.active {
  background: var(--kn-bg-accent-subtle);
}

.slash-name {
  flex: none;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-weight: 600;
  color: var(--agent-accent);
}

.slash-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--agent-muted);
  font-size: 12.5px;
}

.slash-source {
  flex: none;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--agent-muted);
  opacity: 0.7;
}

.composer-shell {
  width: 100%;
  max-width: var(--agent-column);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--agent-border);
  border-radius: 16px;
  background: var(--agent-panel);
  padding: 10px 12px 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.composer-shell:focus-within {
  border-color: var(--agent-accent);
  box-shadow: 0 0 0 3px var(--kn-bg-accent-subtle);
}

.composer {
  width: 100%;
  min-height: 24px;
  max-height: 200px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--agent-text);
  padding: 0;
  font: inherit;
  line-height: 1.5;
}

.composer::placeholder {
  color: var(--agent-muted);
}

.composer-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-select {
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  background: var(--agent-panel-raised);
  color: var(--agent-muted);
  font: inherit;
  font-size: 12.5px;
  padding: 4px 8px;
  cursor: pointer;
  max-width: 160px;
}

.model-select:hover {
  border-color: var(--kn-border-strong);
  color: var(--agent-text);
}

/* Keep the send/stop button pinned to the right of the controls row. */
.composer-button {
  margin-left: auto;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid var(--agent-border);
  background: var(--agent-panel-raised);
  color: var(--agent-text);
  padding: 6px 12px;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
}

button:hover:not(:disabled) {
  background: var(--kn-bg-hover);
  border-color: var(--kn-border-strong);
}

button:disabled {
  cursor: default;
  opacity: 0.4;
}

.permission-actions .primary {
  border-color: var(--agent-accent);
  background: var(--agent-accent);
  color: var(--kn-text-inverse);
}

.permission-actions .primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--agent-accent) 85%, #000);
}

.permission-actions .danger:hover:not(:disabled) {
  border-color: var(--kn-danger);
  color: var(--kn-danger);
  background: var(--kn-danger-bg);
}

/* One dual-use circular button: Send (arrow) when idle, Stop (square) while
   the agent is running. */
.composer-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
}

.send-button {
  border-color: var(--agent-accent);
  background: var(--agent-accent);
  color: var(--kn-text-inverse);
}

.send-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--agent-accent) 85%, #000);
  border-color: color-mix(in srgb, var(--agent-accent) 85%, #000);
}

.send-button:disabled {
  background: var(--agent-panel-raised);
  border-color: var(--agent-border);
  color: var(--agent-muted);
  opacity: 1;
}

.stop-button {
  border-color: var(--agent-text);
  background: var(--agent-text);
  color: var(--agent-bg);
}

.stop-button:hover:not(:disabled) {
  background: var(--agent-muted);
  border-color: var(--agent-muted);
}

.composer-hint {
  max-width: var(--agent-column);
  margin: 6px auto 0;
  text-align: center;
  font-size: 11px;
  color: var(--agent-muted);
}

/* ── Skins ────────────────────────────────────────────────── */
.skin-log .conversation {
  gap: 8px;
  padding-top: 14px;
  font-size: 13.5px;
}

.skin-log .message.user {
  border-radius: 8px;
}

.skin-log .thinking,
.skin-log .permission-card {
  border-radius: 6px;
}

.skin-terminal {
  --agent-bg: var(--kn-agent-terminal-bg);
  --agent-panel: var(--kn-agent-terminal-panel);
  --agent-panel-raised: var(--kn-agent-terminal-panel-raised);
  --agent-border: var(--kn-agent-terminal-border);
  --agent-text: var(--kn-agent-terminal-text);
  --agent-muted: var(--kn-agent-terminal-muted);
  --agent-accent: var(--kn-agent-terminal-accent);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}

.skin-terminal .message.user,
.skin-terminal .thinking,
.skin-terminal .permission-card,
.skin-terminal .composer-shell {
  border-radius: 4px;
}
</style>
