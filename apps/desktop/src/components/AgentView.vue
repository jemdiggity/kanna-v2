<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue"
import { invoke } from "../invoke"

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  (e: "completed", result: AgentMessage): void
  (e: "error", error: string): void
}>()

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface AssistantContent {
  content?: ContentBlock[]
  model?: string
}

interface AgentMessage {
  type: string
  // assistant
  message?: AssistantContent
  // tool_progress
  tool_use_id?: string
  content?: string
  // result
  subtype?: string
  result?: string
  num_turns?: number
  duration_ms?: number
  total_cost_usd?: number
  errors?: string[]
  // system
  message_text?: string
  // generic extra fields
  [key: string]: unknown
}

const messages = ref<AgentMessage[]>([])
const isRunning = ref(true)
const scrollContainer = ref<HTMLElement | null>(null)
let polling = true

function normalizeMessage(raw: Record<string, unknown>): AgentMessage {
  // The SDK serializes assistant messages with content at the top level
  // (not nested under "message"), so we normalize here for the template.
  const msg = raw as AgentMessage

  if (msg.type === "assistant" && !msg.message && Array.isArray((raw as any).content)) {
    msg.message = {
      content: (raw as any).content as ContentBlock[],
      model: (raw as any).model as string | undefined,
    }
  }

  return msg
}

async function pollMessages() {
  console.log(`[AgentView] Starting poll for session: ${props.sessionId}`)
  while (polling) {
    try {
      console.log(`[AgentView] Calling agent_next_message...`)
      const raw = await invoke<Record<string, unknown> | null>("agent_next_message", {
        sessionId: props.sessionId,
      })
      console.log(`[AgentView] Got message:`, raw ? raw.type : "null")
      if (raw) {
        const msg = normalizeMessage(raw)
        messages.value.push(msg)
        await nextTick()
        scrollToBottom()
        // Emit completion when we get a result message
        if (msg.type === "result") {
          isRunning.value = false
          emit("completed", msg)
          break
        }
      } else {
        // null means session ended
        console.log(`[AgentView] Session ended (null message)`)
        isRunning.value = false
        break
      }
    } catch (e: any) {
      console.error("Agent message error:", e)
      isRunning.value = false
      emit("error", e?.message || String(e))
      break
    }
  }
}

function scrollToBottom() {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
  }
}

function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

onMounted(() => {
  pollMessages()
})

onUnmounted(() => {
  polling = false
})
</script>

<template>
  <div ref="scrollContainer" class="agent-view">
    <div v-for="(msg, i) in messages" :key="i" class="message-block">
      <!-- Assistant text -->
      <template v-if="msg.type === 'assistant'">
        <div v-for="(block, j) in (msg.message?.content || [])" :key="j">
          <div v-if="block.type === 'text'" class="text-block">{{ block.text }}</div>
          <div v-else-if="block.type === 'tool_use'" class="tool-block">
            <div class="tool-header">
              <span class="tool-icon">&gt;</span>
              <span class="tool-name">{{ block.name }}</span>
            </div>
            <pre v-if="block.input" class="tool-input">{{ formatToolInput(block.input) }}</pre>
          </div>
          <div v-else-if="block.type === 'thinking'" class="thinking-block">
            <details>
              <summary class="thinking-summary">Thinking...</summary>
              <pre class="thinking-content">{{ block.thinking }}</pre>
            </details>
          </div>
          <div v-else-if="block.type === 'tool_result'" class="tool-result-block">
            <pre class="tool-result-content">{{ typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2) }}</pre>
          </div>
        </div>
      </template>

      <!-- Tool progress -->
      <template v-else-if="msg.type === 'tool_progress'">
        <div class="progress-block">
          <span class="progress-label">{{ msg.content || 'Working' }}</span>
        </div>
      </template>

      <!-- Result -->
      <template v-else-if="msg.type === 'result'">
        <div
          class="result-block"
          :class="{
            success: msg.subtype === 'success',
            error: msg.subtype !== 'success',
          }"
        >
          <div class="result-header">
            {{ msg.subtype === 'success' ? 'Completed' : 'Error' }}
          </div>
          <div class="result-details">
            <span v-if="msg.num_turns">{{ msg.num_turns }} turns</span>
            <span v-if="msg.duration_ms"> / {{ (msg.duration_ms / 1000).toFixed(1) }}s</span>
            <span v-if="msg.total_cost_usd"> / ${{ msg.total_cost_usd.toFixed(4) }}</span>
          </div>
          <pre v-if="msg.result" class="result-text">{{ msg.result }}</pre>
          <div v-if="msg.errors && msg.errors.length > 0" class="result-errors">
            <div v-for="(err, ei) in msg.errors" :key="ei" class="result-error">{{ err }}</div>
          </div>
        </div>
      </template>

      <!-- System messages -->
      <template v-else-if="msg.type === 'system'">
        <div class="system-block">{{ (msg as any).message || msg.subtype || 'system' }}</div>
      </template>
    </div>

    <div v-if="isRunning" class="running-indicator">
      <span class="pulse"></span> Agent running...
    </div>
  </div>
</template>

<style scoped>
.agent-view {
  flex: 1;
  overflow-y: auto;
  background: #1a1a1a;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  padding: 12px 16px;
  color: #e0e0e0;
}

.message-block {
  margin-bottom: 8px;
}

/* Text */
.text-block {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Tool calls */
.tool-block {
  margin: 6px 0;
  border-left: 2px solid #0066cc;
  padding-left: 12px;
}

.tool-header {
  color: #4ec9b0;
  font-weight: 600;
  margin-bottom: 2px;
}

.tool-icon {
  margin-right: 6px;
  color: #888;
}

.tool-name {
  color: #4ec9b0;
}

.tool-input {
  color: #888;
  font-size: 12px;
  margin: 4px 0;
  max-height: 200px;
  overflow-y: auto;
  background: #111;
  padding: 6px 8px;
  border-radius: 4px;
}

/* Tool results */
.tool-result-block {
  margin: 4px 0 4px 14px;
  border-left: 2px solid #333;
  padding-left: 12px;
}

.tool-result-content {
  color: #999;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

/* Thinking */
.thinking-block {
  margin: 4px 0;
}

.thinking-summary {
  color: #666;
  cursor: pointer;
  font-style: italic;
  font-size: 12px;
}

.thinking-content {
  color: #666;
  font-size: 12px;
  margin-top: 4px;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}

/* Results */
.result-block {
  margin: 12px 0;
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #333;
}

.result-block.success {
  border-color: #2ea04366;
  background: #2ea04311;
}

.result-block.error {
  border-color: #f8514966;
  background: #f8514911;
}

.result-header {
  font-weight: 600;
  margin-bottom: 4px;
}

.result-block.success .result-header {
  color: #2ea043;
}
.result-block.error .result-header {
  color: #f85149;
}

.result-details {
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}

.result-text {
  white-space: pre-wrap;
  font-size: 12px;
  color: #aaa;
  margin-top: 4px;
}

.result-errors {
  margin-top: 6px;
}

.result-error {
  color: #f85149;
  font-size: 12px;
  padding: 2px 0;
}

/* System */
.system-block {
  color: #666;
  font-size: 12px;
  font-style: italic;
  padding: 2px 0;
}

/* Progress */
.progress-block {
  color: #888;
  font-size: 12px;
}

/* Running indicator */
.running-indicator {
  color: #4ec9b0;
  font-size: 12px;
  padding: 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pulse {
  width: 8px;
  height: 8px;
  background: #4ec9b0;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
