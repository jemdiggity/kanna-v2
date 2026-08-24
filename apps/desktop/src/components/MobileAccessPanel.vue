<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { renderPairingQr } from "../utils/pairingQr";

type ServerStatus = "running" | "stopped" | "error";

const props = defineProps<{
  desktopName: string;
  serverStatus: ServerStatus;
  pairingCode: string | null;
  pairingPayload: string | null;
  expiresAtUnixMs?: number | null;
}>();

const emit = defineEmits<{
  (e: "start-pairing"): void;
}>();

const statusLabel = computed(() => {
  if (props.serverStatus === "running") return "Online";
  if (props.serverStatus === "stopped") return "Offline";
  return "Needs attention";
});

const statusClass = computed(() => `status-${props.serverStatus}`);
const pairingQrUrl = ref<string | null>(null);
const pairingQrError = ref<string | null>(null);
const pairingExpired = ref(false);
const pairingActionLabel = computed(() =>
  props.pairingCode && !pairingExpired.value ? "Refresh" : "Start pairing"
);
let qrGeneration = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => [props.pairingCode, props.expiresAtUnixMs] as const,
  ([pairingCode, expiresAtUnixMs]) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    pairingExpired.value = Boolean(
      pairingCode && expiresAtUnixMs && expiresAtUnixMs <= Date.now()
    );
    if (!pairingCode || !expiresAtUnixMs || pairingExpired.value) return;

    expiryTimer = setTimeout(() => {
      pairingExpired.value = true;
      expiryTimer = null;
    }, Math.max(0, expiresAtUnixMs - Date.now()));
  },
  { immediate: true },
);

watch(
  () => [props.pairingPayload, pairingExpired.value] as const,
  async ([payload, expired]) => {
    const generation = ++qrGeneration;
    pairingQrUrl.value = null;
    pairingQrError.value = null;
    if (!payload || expired) return;

    try {
      const url = await renderPairingQr(payload);
      if (generation === qrGeneration) pairingQrUrl.value = url;
    } catch (error) {
      if (generation === qrGeneration) {
        pairingQrError.value = error instanceof Error
          ? error.message
          : "Could not render the pairing QR code.";
      }
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (expiryTimer) clearTimeout(expiryTimer);
});
</script>

<template>
  <section class="mobile-access-panel" data-testid="mobile-access-panel">
    <div class="panel-header">
      <div>
        <p class="eyebrow">Mobile Access</p>
        <h3 class="desktop-name">{{ desktopName }}</h3>
      </div>
      <span
        class="status-pill"
        :class="statusClass"
        data-testid="mobile-access-status"
      >{{ statusLabel }}</span>
    </div>

    <p class="description">
      Pair a phone or tablet to browse tasks and recent activity on this desktop.
    </p>

    <div class="pairing-area">
      <div v-if="pairingCode && !pairingExpired" class="pairing-session">
        <img
          v-if="pairingQrUrl"
          :src="pairingQrUrl"
          alt="Mobile pairing QR code"
          class="pairing-qr"
          data-testid="mobile-access-pairing-qr"
        />
        <span v-else-if="pairingQrError" class="qr-error">{{ pairingQrError }}</span>
        <div class="pairing-code">
          <span class="label">Pairing code</span>
          <code
            class="code"
            data-testid="mobile-access-pairing-code"
          >{{ pairingCode }}</code>
          <span class="expiry">Expires in five minutes</span>
        </div>
      </div>
      <div v-else class="pairing-code">
        <span class="label">Pairing code</span>
        <span class="placeholder">No pairing session active</span>
      </div>

      <button
        type="button"
        class="start-pairing"
        data-testid="mobile-access-start-pairing"
        @click="emit('start-pairing')"
      >
        {{ pairingActionLabel }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.mobile-access-panel {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 10px;
  background: var(--kn-bg-panel-raised);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--kn-accent);
}

.desktop-name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--kn-text-primary);
}

.status-pill {
  flex: none;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}

.status-running {
  color: var(--kn-success);
  background: var(--kn-success-bg);
  border-color: var(--kn-success);
}

.status-stopped {
  color: var(--kn-text-muted);
  background: var(--kn-bg-panel);
  border-color: var(--kn-border-default);
}

.status-error {
  color: var(--kn-danger);
  background: var(--kn-danger-bg);
  border-color: var(--kn-danger);
}

.description {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kn-text-secondary);
}

.pairing-area {
  margin-top: 14px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.pairing-session {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.pairing-qr {
  width: 185px;
  height: 185px;
  border-radius: 8px;
  background: #fff;
}

.pairing-code {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 11px;
  color: var(--kn-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.code {
  display: inline-flex;
  align-self: flex-start;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--kn-border-strong);
  background: var(--kn-bg-input);
  color: var(--kn-text-primary);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.placeholder {
  font-size: 12px;
  color: var(--kn-text-muted);
}

.expiry,
.qr-error {
  font-size: 11px;
  color: var(--kn-text-muted);
}

.qr-error {
  max-width: 120px;
  color: var(--kn-danger);
}

.start-pairing {
  flex: none;
  padding: 8px 12px;
  border: 1px solid var(--kn-accent-hover);
  border-radius: 7px;
  background: var(--kn-accent);
  color: var(--kn-text-inverse);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.start-pairing:hover {
  background: var(--kn-accent-hover);
}

.start-pairing:focus-visible {
  outline: 2px solid var(--kn-accent);
  outline-offset: 2px;
}
</style>
