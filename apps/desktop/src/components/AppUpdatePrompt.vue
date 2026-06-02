<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { type useAppUpdate } from "../composables/useAppUpdate";

type AppUpdateController = ReturnType<typeof useAppUpdate>;

const props = defineProps<{
  controller: AppUpdateController;
}>();

const {
  status,
  updateVersion,
  releaseNotes,
  publishedAt,
  downloadedBytes,
  contentLength,
  errorMessage,
  visible,
  install,
  dismiss,
  restartNow,
} = props.controller;

const { t } = useI18n();

const isAvailable = computed(() => status.value === "available");
const isDownloading = computed(() => status.value === "downloading");
const isReadyToRestart = computed(() => status.value === "readyToRestart");
const isError = computed(() => status.value === "error");

const progressText = computed(() => {
  if (contentLength.value == null || contentLength.value <= 0) {
    return `${downloadedBytes.value}`;
  }
  return `${downloadedBytes.value} / ${contentLength.value}`;
});

async function retryInstall() {
  await install();
}

async function dismissUpdate() {
  dismiss();
}

async function restartUpdate() {
  await restartNow();
}
</script>

<template>
  <Transition name="update-prompt">
    <section v-if="visible" class="update-prompt">
      <header class="update-prompt__header">
        <div class="update-prompt__titles">
          <p class="update-prompt__eyebrow">{{ t("app.update.title") }}</p>
          <div class="update-prompt__status" role="status" aria-live="polite" aria-atomic="true">
            <h2 class="update-prompt__headline">
              <template v-if="isAvailable">{{ t("app.update.available") }}</template>
              <template v-else-if="isDownloading">{{ t("app.update.downloading") }}</template>
              <template v-else-if="isReadyToRestart">{{ t("app.update.readyToRestart") }}</template>
              <template v-else-if="isError">{{ t("app.update.error") }}</template>
            </h2>
          </div>
        </div>
        <button
          v-if="isAvailable || isError"
          class="update-prompt__icon-button"
          type="button"
          :aria-label="t('actions.dismiss')"
          :data-testid="isAvailable ? 'update-dismiss' : 'update-dismiss-error'"
          @click="dismissUpdate"
        >
          ×
        </button>
      </header>

      <div class="update-prompt__body">
        <template v-if="isAvailable">
          <p class="update-prompt__version">{{ updateVersion }}</p>
          <p v-if="publishedAt" class="update-prompt__meta">{{ publishedAt }}</p>
          <p v-if="releaseNotes" class="update-prompt__notes">{{ releaseNotes }}</p>
        </template>

        <template v-else-if="isDownloading">
          <div class="update-prompt__progress-row">
            <progress
              v-if="contentLength != null && contentLength > 0"
              class="update-prompt__progress"
              :value="downloadedBytes"
              :max="contentLength"
            />
            <progress v-else class="update-prompt__progress" />
            <span class="update-prompt__progress-text">{{ progressText }}</span>
          </div>
        </template>

        <template v-else-if="isReadyToRestart">
          <p class="update-prompt__notes">{{ t("app.update.restartReady") }}</p>
        </template>

        <template v-else-if="isError">
          <p v-if="errorMessage" class="update-prompt__notes">{{ errorMessage }}</p>
          <p v-else class="update-prompt__notes">{{ t("app.update.errorFallback") }}</p>
        </template>
      </div>

      <footer class="update-prompt__actions">
        <button
          v-if="isAvailable"
          class="update-prompt__button update-prompt__button--primary"
          type="button"
          data-testid="update-install"
          @click="retryInstall"
        >
          {{ t("app.update.install") }}
        </button>
        <button
          v-if="isDownloading"
          class="update-prompt__button update-prompt__button--primary"
          type="button"
          disabled
        >
          {{ t("app.update.downloading") }}
        </button>
        <button
          v-if="isReadyToRestart"
          class="update-prompt__button update-prompt__button--primary"
          type="button"
          data-testid="update-restart"
          @click="restartUpdate"
        >
          {{ t("app.update.restartNow") }}
        </button>
        <button
          v-if="isReadyToRestart"
          class="update-prompt__button"
          type="button"
          data-testid="update-later"
          @click="dismissUpdate"
        >
          {{ t("app.update.later") }}
        </button>
        <button
          v-if="isError"
          class="update-prompt__button update-prompt__button--primary"
          type="button"
          data-testid="update-retry"
          @click="retryInstall"
        >
          {{ t("app.update.retry") }}
        </button>
        <button
          v-if="isAvailable || isError"
          class="update-prompt__button"
          type="button"
          @click="dismissUpdate"
        >
          {{ t("actions.dismiss") }}
        </button>
      </footer>
    </section>
  </Transition>
</template>

<style scoped>
.update-prompt {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1150;
  width: min(420px, calc(100vw - 32px));
  max-height: min(640px, calc(100vh - 32px));
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 16px;
  background: var(--kn-bg-panel);
  box-shadow: var(--kn-shadow-modal);
  backdrop-filter: blur(16px);
  color: var(--kn-text-primary);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.update-prompt__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.update-prompt__titles {
  min-width: 0;
}

.update-prompt__eyebrow {
  color: var(--kn-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.update-prompt__headline {
  margin-top: 4px;
  font-size: 16px;
  line-height: 1.25;
}

.update-prompt__status {
  margin-top: 4px;
}

.update-prompt__icon-button {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  background: var(--kn-bg-hover);
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.update-prompt__body {
  margin-top: 12px;
  min-height: 0;
  display: grid;
  gap: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.update-prompt__version {
  color: var(--kn-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.update-prompt__meta,
.update-prompt__notes,
.update-prompt__progress-text {
  color: var(--kn-text-muted);
  font-size: 13px;
}

.update-prompt__notes {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.update-prompt__progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.update-prompt__progress {
  width: 100%;
  height: 10px;
  accent-color: var(--kn-accent);
}

.update-prompt__actions {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.update-prompt__button {
  border: 1px solid var(--kn-border-strong);
  border-radius: 999px;
  background: var(--kn-bg-panel-raised);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 14px;
}

.update-prompt__button:disabled {
  cursor: default;
  opacity: 0.7;
}

.update-prompt__button--primary {
  border-color: var(--kn-accent);
  background: var(--kn-bg-accent-subtle);
}

.update-prompt-enter-active,
.update-prompt-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.update-prompt-enter-from,
.update-prompt-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
