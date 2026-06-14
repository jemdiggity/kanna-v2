<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import MarkdownIt from "markdown-it";
import type { AgentEvent, PermissionDecision, TurnStats } from "@kanna/agent-protocol";
import { getActivePinia } from "pinia";
import type { BundledLanguage } from "shiki";
import { useAgentStream } from "../composables/useAgentStream";
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
}>();

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const store = getActivePinia() ? useKannaStore() : null;
const themeRuntime = useThemeRuntime();
const shikiTheme = computed(() => getShikiTheme(themeRuntime.effectiveCodeTheme.value));
const composer = ref("");
const denyReasons = ref<Record<string, string>>({});
const scrollContainer = ref<HTMLElement | null>(null);
const appearance = ref<AgentMessageAppearance>(normalizeAppearance(store?.agentMessageAppearance ?? null));
const renderedAssistant = ref<Record<number, string>>({});
const stream = useAgentStream(props.sessionId);
let highlighterPromise: Promise<MarkdownHighlighter> | null = null;

const displayEvents = computed(() =>
  stream.events.value.filter((item) =>
    item.event.type !== "raw" && item.event.type !== "diagnostic" && item.event.type !== "permission_resolved",
  ),
);
const debugEvents = computed(() =>
  stream.events.value.filter((item) => item.event.type === "raw" || item.event.type === "diagnostic"),
);
const lastStats = computed(() => {
  const completed = [...stream.events.value].reverse().find((item) => item.event.type === "turn_completed");
  return completed?.event.type === "turn_completed" ? completed.event.stats : null;
});

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

function sendComposer() {
  const text = composer.value.trim();
  if (!text) return;
  stream.sendInput(text);
  composer.value = "";
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendComposer();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    stream.interrupt();
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
</script>

<template>
  <section class="agent-message-view" :class="`skin-${appearance}`">
    <div ref="scrollContainer" class="agent-scroll" data-testid="agent-message-view">
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
          <div class="message user">{{ item.event.text }}</div>
        </template>

        <template v-else-if="item.event.type === 'assistant_text'">
          <div class="message assistant" v-html="renderedAssistant[item.seq] ?? fallbackMarkdown(item.event.text)" />
        </template>

        <template v-else-if="item.event.type === 'thinking'">
          <details class="thinking">
            <summary>Thinking</summary>
            <pre>{{ item.event.text }}</pre>
          </details>
        </template>

        <template v-else-if="item.event.type === 'tool_call'">
          <details class="tool-card" open>
            <summary>{{ toolTitle(item.event) }}</summary>
            <pre>{{ formatValue(item.event.input) }}</pre>
          </details>
        </template>

        <template v-else-if="item.event.type === 'tool_result'">
          <details class="tool-card result" :class="{ error: item.event.is_error }">
            <summary>Result{{ item.event.truncated ? " · truncated" : "" }}</summary>
            <pre>{{ item.event.output }}</pre>
          </details>
        </template>

        <template v-else-if="item.event.type === 'tool_progress'">
          <div class="event-label">{{ item.event.message }}</div>
        </template>

        <template v-else-if="item.event.type === 'permission_request'">
          <div class="permission-card" :data-testid="`permission-${item.event.request_id}`">
            <div class="permission-title">{{ toolTitle(item.event) }} permission</div>
            <pre>{{ formatValue(item.event.input) }}</pre>
            <input
              v-model="denyReasons[item.event.request_id]"
              class="deny-reason"
              placeholder="Reason for denial"
              :data-testid="`permission-reason-${item.event.request_id}`"
            />
            <div class="permission-actions">
              <button type="button" @click="resolvePermission(item.event.request_id, { kind: 'allow' })">Allow</button>
              <button type="button" @click="resolvePermission(item.event.request_id, { kind: 'allow_session' })">Allow for session</button>
              <button
                type="button"
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
          <div class="event-label">Session {{ item.event.reason }}{{ item.event.message ? ` · ${item.event.message}` : "" }}</div>
        </template>
      </article>

      <details v-if="debugEvents.length > 0" class="debug-events">
        <summary>Debug</summary>
        <pre v-for="item in debugEvents" :key="item.seq">{{ formatValue(item.event) }}</pre>
      </details>

      <div v-if="stream.error.value" class="stream-error">{{ stream.error.value }}</div>
    </div>

    <footer class="agent-footer">
      <span class="turn-stats">{{ statsLabel(lastStats) }}</span>
      <button type="button" class="stop-button" @click="stream.interrupt">Stop</button>
      <textarea
        v-model="composer"
        class="composer"
        rows="1"
        placeholder="Message agent"
        data-testid="agent-composer"
        @keydown="handleComposerKeydown"
      />
      <button type="button" class="send-button" :disabled="!composer.trim()" @click="sendComposer">Send</button>
    </footer>
  </section>
</template>

<style scoped>
.agent-message-view {
  --agent-bg: var(--kn-bg-app);
  --agent-panel: var(--kn-bg-panel);
  --agent-border: var(--kn-border);
  --agent-text: var(--kn-text-primary);
  --agent-muted: var(--kn-text-muted);
  --agent-accent: var(--kn-accent);
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  background: var(--agent-bg);
  color: var(--agent-text);
}

.agent-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.event {
  margin: 0 0 10px;
}

.message,
.tool-card,
.permission-card,
.thinking,
.debug-events {
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  background: var(--agent-panel);
  padding: 10px 12px;
}

.message :deep(p) {
  margin: 0 0 8px;
}

.message :deep(p:last-child) {
  margin-bottom: 0;
}

.message.user {
  margin-left: auto;
  max-width: 760px;
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--agent-accent) 14%, var(--agent-panel));
}

.message.assistant {
  max-width: 860px;
}

pre {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.event-label,
.turn-stats {
  color: var(--agent-muted);
  font-size: 12px;
}

.tool-card summary,
.thinking summary,
.debug-events summary,
.permission-title {
  font-weight: 600;
}

.tool-card.error {
  border-color: var(--kn-danger);
}

.permission-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.deny-reason {
  width: 100%;
  margin-top: 10px;
  border: 1px solid var(--agent-border);
  border-radius: 4px;
  background: var(--kn-bg-input);
  color: var(--agent-text);
  padding: 6px 8px;
}

.agent-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(220px, 520px) auto;
  gap: 8px;
  align-items: center;
  border-top: 1px solid var(--agent-border);
  padding: 8px;
  background: var(--agent-panel);
}

.permission-actions {
  display: flex;
  align-items: center;
}

button {
  border: 1px solid var(--agent-border);
  border-radius: 6px;
  background: var(--kn-bg-button);
  color: var(--agent-text);
  padding: 5px 9px;
  font: inherit;
  cursor: pointer;
}

button.active {
  border-color: var(--agent-accent);
  color: var(--agent-accent);
}

button:disabled {
  cursor: default;
  opacity: 0.5;
}

.composer {
  min-height: 30px;
  max-height: 120px;
  resize: vertical;
  border: 1px solid var(--agent-border);
  border-radius: 6px;
  background: var(--kn-bg-input);
  color: var(--agent-text);
  padding: 6px 8px;
  font: inherit;
}

.skin-log .agent-scroll {
  padding: 10px 14px;
}

.skin-log .message,
.skin-log .tool-card,
.skin-log .permission-card,
.skin-log .thinking {
  border-radius: 4px;
  padding: 6px 8px;
}

.skin-terminal {
  --agent-bg: #101214;
  --agent-panel: #15191d;
  --agent-border: #2c333a;
  --agent-text: #d9f0dd;
  --agent-muted: #8aa094;
  --agent-accent: #62d26f;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}

.skin-terminal .message,
.skin-terminal .tool-card,
.skin-terminal .permission-card,
.skin-terminal .thinking {
  border-radius: 0;
}

.stream-error {
  color: var(--kn-danger);
  font-size: 12px;
}
</style>
