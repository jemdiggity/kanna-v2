<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="toast-container" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :class="toast.type"
        role="alert"
      >
        <span class="toast-message">{{ toast.message }}</span>
        <button class="toast-dismiss" @click="dismiss(toast.id)" :aria-label="$t('actions.dismiss')">&times;</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(360px, calc(100vw - 24px));
  max-width: 360px;
  padding: 8px 12px;
  border-radius: 4px;
  border-left: 3px solid;
  box-shadow: var(--kn-shadow-modal);
  color: var(--kn-text-primary);
  font-size: 13px;
  pointer-events: auto;
}

.toast.info {
  background: var(--kn-bg-accent-subtle);
  border-left-color: var(--kn-accent);
}

.toast.warning {
  background: var(--kn-warning-bg);
  border-left-color: var(--kn-warning);
}

.toast.error {
  background: var(--kn-danger-bg);
  border-left-color: var(--kn-danger);
}

.toast-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
}

.toast-dismiss {
  background: none;
  border: none;
  color: var(--kn-text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.toast-dismiss:hover {
  color: var(--kn-text-primary);
}

/* Suppress TransitionGroup move animation */
.toast-move {
  transition: none;
}

/* Transitions */
.toast-enter-active {
  transition: all 0.3s ease;
}

.toast-leave-active {
  transition: all 0.2s ease;
  position: absolute;
  right: 0;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
}
</style>
