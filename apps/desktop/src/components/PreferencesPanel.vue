<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentProvider } from "@kanna/db"
import { invoke } from "../invoke"
import { useModalZIndex } from '../composables/useModalZIndex'
import MobileAccessPanel from './MobileAccessPanel.vue'
import { macOsTextInputAttrs } from '../utils/textInput'
import { getConfiguredDesktopAuthSession } from '../services/desktopAuthSdk'
import type { DesktopAuthSession, DesktopAuthState } from '../services/desktopAuth'
import type { AppThemePreference, CodeThemePreference } from '../theme/theme'

useI18n()
const { zIndex } = useModalZIndex()
const isDev = import.meta.env.DEV

type MobileServerStatus = "running" | "stopped" | "error"

interface MobileServerStatusResponse {
  desktopName?: string
  state?: string
  pairingCode?: string | null
}

interface PairingSessionResponse {
  pairingCode?: string | null
  code?: string | null
  desktopName?: string
  state?: string
}

defineProps<{
  preferences: {
    suspendAfterMinutes: number
    killAfterMinutes: number
    ideCommand: string
    locale: string
    devLingerTerminals: boolean
    defaultAgentProvider: AgentProvider
    appTheme: AppThemePreference
    codeTheme: CodeThemePreference
  }
}>()

const emit = defineEmits<{
  update: [key: string, value: string]
  close: []
}>()

const activeTab = ref<'general' | 'account' | 'developer'>('general')

const tabs: Array<'general' | 'account' | 'developer'> = isDev
  ? ['general', 'account', 'developer']
  : ['general', 'account']
const mobileDesktopName = ref("This desktop")
const mobileServerStatus = ref<MobileServerStatus>("stopped")
const pairingCode = ref<string | null>(null)
const authSession = ref<DesktopAuthSession | null>(null)
const authState = ref<DesktopAuthState>({ status: "signedOut" })
const accountEmail = ref("")
const accountPassword = ref("")
const accountMessage = ref("")
let unsubscribeAuth: (() => void) | null = null

const isSigningIn = computed(() => authState.value.status === "signingIn")
const signedInUserEmail = computed(() =>
  authState.value.status === "signedIn"
    ? authState.value.user.email ?? authState.value.user.uid
    : null
)

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

function normalizeMobileServerStatus(status?: string): MobileServerStatus {
  if (status === "running" || status === "stopped" || status === "error") {
    return status
  }
  return "error"
}

async function refreshMobileAccess() {
  try {
    const status = await invoke<MobileServerStatusResponse>("mobile_server_status")
    if (status.desktopName) {
      mobileDesktopName.value = status.desktopName
    }
    mobileServerStatus.value = normalizeMobileServerStatus(status.state)
    pairingCode.value = status.pairingCode ?? null
  } catch (error) {
    console.error("[PreferencesPanel] failed to load mobile access status:", error)
    mobileServerStatus.value = "error"
  }
}

async function startPairing() {
  try {
    const session = await invoke<PairingSessionResponse>("create_mobile_pairing_session")
    if (session.desktopName) {
      mobileDesktopName.value = session.desktopName
    }
    mobileServerStatus.value = session.state
      ? normalizeMobileServerStatus(session.state)
      : "running"
    pairingCode.value = session.pairingCode ?? session.code ?? null
  } catch (error) {
    console.error("[PreferencesPanel] failed to create pairing session:", error)
    mobileServerStatus.value = "error"
  }
}

async function refreshAccountSession() {
  try {
    const session = await getConfiguredDesktopAuthSession()
    authSession.value = session
    await session.initialize()
    unsubscribeAuth?.()
    unsubscribeAuth = session.subscribe((state) => {
      authState.value = state
      if (state.status === "signedIn") {
        accountMessage.value = ""
        accountPassword.value = ""
      } else if (state.status === "error") {
        accountMessage.value = state.message
      }
    })
  } catch (error) {
    accountMessage.value = error instanceof Error ? error.message : "Failed to initialize sign-in."
  }
}

async function signInAccount() {
  accountMessage.value = ""
  await authSession.value?.signInWithEmailPassword({
    email: accountEmail.value,
    password: accountPassword.value,
  })
}

async function signOutAccount() {
  accountMessage.value = ""
  await authSession.value?.signOut()
}

onMounted(() => {
  overlayRef.value?.focus()
  void refreshMobileAccess()
  void refreshAccountSession()
})

onBeforeUnmount(() => {
  unsubscribeAuth?.()
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
            class="tab"
            data-testid="preferences-account-tab"
            :class="{ active: activeTab === 'account' }"
            @click="activeTab = 'account'"
          >Account</button>
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
          <label>{{ $t('preferences.theme') }}</label>
          <select
            data-testid="app-theme-select"
            :value="preferences.appTheme"
            @change="emit('update', 'appTheme', ($event.target as HTMLSelectElement).value)"
          >
            <option value="system">{{ $t('preferences.themeSystem') }}</option>
            <option value="light">{{ $t('preferences.themeLight') }}</option>
            <option value="dark">{{ $t('preferences.themeDark') }}</option>
          </select>
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.codeTheme') }}</label>
          <select
            data-testid="code-theme-select"
            :value="preferences.codeTheme"
            @change="emit('update', 'codeTheme', ($event.target as HTMLSelectElement).value)"
          >
            <option value="match">{{ $t('preferences.codeThemeMatch') }}</option>
            <option value="light">{{ $t('preferences.codeThemeLight') }}</option>
            <option value="dark">{{ $t('preferences.codeThemeDark') }}</option>
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
            v-bind="macOsTextInputAttrs"
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

      <div v-if="activeTab === 'account'" class="prefs-body">
        <section class="account-panel">
          <div v-if="signedInUserEmail" class="account-signed-in">
            <span class="account-label">Signed in</span>
            <strong>{{ signedInUserEmail }}</strong>
            <button type="button" class="secondary-button" @click="signOutAccount">
              Sign out
            </button>
          </div>

          <form v-else class="account-form" data-testid="account-sign-in" @submit.prevent="signInAccount">
            <label class="account-field">
              <span>Email</span>
              <input
                v-model="accountEmail"
                data-testid="account-email"
                v-bind="macOsTextInputAttrs"
                type="email"
                autocomplete="email"
                required
              />
            </label>

            <label class="account-field">
              <span>Password</span>
              <input
                v-model="accountPassword"
                data-testid="account-password"
                v-bind="macOsTextInputAttrs"
                type="password"
                autocomplete="current-password"
                required
              />
            </label>

            <button type="submit" class="primary-button" :disabled="isSigningIn">
              {{ isSigningIn ? "Signing in..." : "Sign in" }}
            </button>
          </form>

          <p v-if="accountMessage" class="account-message">{{ accountMessage }}</p>
        </section>
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

        <MobileAccessPanel
          :desktop-name="mobileDesktopName"
          :server-status="mobileServerStatus"
          :pairing-code="pairingCode"
          @start-pairing="startPairing"
        />
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
.pref-row input[type="text"],
.account-field input {
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

.account-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.account-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.account-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: #bbb;
}

.account-field input {
  width: 100%;
  box-sizing: border-box;
}

.account-signed-in {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: #e0e0e0;
}

.account-label {
  font-size: 11px;
  color: #8b98a8;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.account-message {
  margin: 0;
  color: #ffb39d;
  font-size: 12px;
  line-height: 1.4;
}

.primary-button,
.secondary-button {
  align-self: flex-start;
  padding: 7px 12px;
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.primary-button {
  border: 1px solid #0077ee;
  background: #0066cc;
}

.primary-button:disabled {
  opacity: 0.65;
  cursor: default;
}

.secondary-button {
  border: 1px solid #555;
  background: #333;
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
