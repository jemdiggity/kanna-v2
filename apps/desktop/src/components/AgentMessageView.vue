<script setup lang="ts">
import type { AgentProvider } from "../types/kanna";
import { useAgentMessageView } from "../composables/useAgentMessageView";

const props = defineProps<{
  sessionId: string;
  agentProvider?: AgentProvider;
  worktreePath?: string;
  recoverSession?: (sessionId: string) => Promise<void>;
}>();

const {
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
} = useAgentMessageView(props);
</script>

<template>
  <section class="agent-message-view" :class="[`skin-${appearance}`, `theme-${appTheme}`]">
    <div
      ref="scrollContainer"
      class="agent-scroll"
      data-testid="agent-message-view"
      @click="handleRenderedMessageClick"
    >
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

<style scoped src="./AgentMessageView.css"></style>
