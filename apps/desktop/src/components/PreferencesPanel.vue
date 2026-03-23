<script setup lang="ts">
import { useI18n } from 'vue-i18n'

useI18n()

defineProps<{
  preferences: {
    suspendAfterMinutes: number
    killAfterMinutes: number
    ideCommand: string
    locale: string
  }
}>()

const emit = defineEmits<{
  update: [key: string, value: string]
  close: []
}>()

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault()
    emit("close")
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="prefs-panel">
      <div class="prefs-header">
        <h3>{{ $t('preferences.title') }}</h3>
      </div>

      <div class="prefs-body">
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
  z-index: 1000;
}

.prefs-panel {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.prefs-header {
  padding: 14px 16px 0;
  border-bottom: 1px solid #333;
  padding-bottom: 12px;
}

.prefs-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.prefs-body {
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
