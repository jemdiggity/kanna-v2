<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentProvider } from "@kanna/db"
import { useModalZIndex } from '../composables/useModalZIndex'

useI18n()
const { zIndex } = useModalZIndex()
const isDev = import.meta.env.DEV

defineProps<{
  preferences: {
    suspendAfterMinutes: number
    killAfterMinutes: number
    ideCommand: string
    locale: string
    devLingerTerminals: boolean
    defaultAgentProvider: AgentProvider
  }
}>()

const emit = defineEmits<{
  update: [key: string, value: string]
  close: []
}>()

const activeTab = ref<'general' | 'developer'>('general')

const tabs: Array<'general' | 'developer'> = isDev ? ['general', 'developer'] : ['general']

function cycleTab(direction: -1 | 1) {
  const idx = tabs.indexOf(activeTab.value)
  activeTab.value = tabs[(idx + direction + tabs.length) % tabs.length]
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault()
    emit("close")
  }
}

const overlayRef = ref<HTMLDivElement | null>(null)

onMounted(() => {
  overlayRef.value?.focus()
})

defineExpose({ cycleTab })
</script>

<template>
  <div ref="overlayRef" class="modal-overlay" :style="{ zIndex }" tabindex="-1" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="prefs-panel">
      <div class="prefs-header">
        <div class="tab-bar">
          <button
            class="tab"
            :class="{ active: activeTab === 'general' }"
            @click="activeTab = 'general'"
          >{{ $t('preferences.title') }}</button>
          <button
            v-if="isDev"
            class="tab"
            :class="{ active: activeTab === 'developer' }"
            @click="activeTab = 'developer'"
          >Developer</button>
        </div>
      </div>

      <div v-if="activeTab === 'general'" class="prefs-body">
        <div class="pref-row">
          <label>{{ $t('preferences.language') }}</label>
          <select
            :value="preferences.locale"
            @change="emit('update', 'locale', ($event.target as HTMLSelectElement).value)"
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.suspendAfter') }}</label>
          <input
            type="number"
            :value="preferences.suspendAfterMinutes"
            min="1"
            @change="emit('update', 'suspendAfterMinutes', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.killAfter') }}</label>
          <input
            type="number"
            :value="preferences.killAfterMinutes"
            min="5"
            @change="emit('update', 'killAfterMinutes', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.ideCommand') }}</label>
          <input
            type="text"
            :value="preferences.ideCommand"
            :placeholder="$t('preferences.idePlaceholder')"
            @change="emit('update', 'ideCommand', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.defaultAgent') }}</label>
          <select
            :value="preferences.defaultAgentProvider"
            @change="emit('update', 'defaultAgentProvider', ($event.target as HTMLSelectElement).value)"
          >
            <option value="claude">Claude</option>
            <option value="copilot">Copilot</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      </div>

      <div v-if="activeTab === 'developer'" class="prefs-body">
        <div class="pref-row">
          <label>Linger terminals after teardown</label>
          <input
            type="checkbox"
            :checked="preferences.devLingerTerminals"
            @change="emit('update', 'dev.lingerTerminals', ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
          />
        </div>
      </div>

      <div class="prefs-footer">
        <button class="btn-done" @click="emit('close')">{{ $t('actions.done') }}</button>
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
  outline: none;
}

.prefs-panel {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 420px;
  max-width: 90vw;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}


.prefs-header {
  border-bottom: 1px solid #333;
}

.tab-bar {
  display: flex;
  padding: 0 12px;
}

.tab {
  padding: 10px 12px 8px;
  font-size: 13px;
  font-weight: 500;
  color: #888;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: #ccc;
}

.tab.active {
  color: #e0e0e0;
  border-bottom-color: #0066cc;
}

.prefs-body {
  flex: 1;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pref-row label {
  font-size: 13px;
  color: #bbb;
  flex: 1;
  white-space: nowrap;
}

.pref-row input[type="number"],
.pref-row input[type="text"] {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 5px 8px;
  width: 160px;
  outline: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
}

.pref-row input[type="number"] {
  width: 80px;
}

.pref-row input:focus {
  border-color: #0066cc;
}

.pref-row input[type="checkbox"] {
  accent-color: #0066cc;
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.pref-row select {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 5px 8px;
  width: 160px;
  outline: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
}

.pref-row select:focus {
  border-color: #0066cc;
}

.prefs-footer {
  display: flex;
  justify-content: flex-end;
  padding: 10px 16px 14px;
  border-top: 1px solid #333;
}

.btn-done {
  padding: 5px 20px;
  background: #0066cc;
  border: 1px solid #0077ee;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.btn-done:hover {
  background: #0077ee;
}
</style>
