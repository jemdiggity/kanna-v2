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
        <button class="toast-dismiss" @click="dismiss(toast.id)" aria-label="Dismiss">&times;</button>
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
  max-width: 360px;
  padding: 8px 12px;
  border-radius: 4px;
  border-left: 3px solid;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  color: #e0e0e0;
  font-size: 13px;
  pointer-events: auto;
}

.toast.warning {
  background: #2a2a1a;
  border-left-color: #e3b341;
}

.toast.error {
  background: #2a1a1a;
  border-left-color: #f85149;
}

.toast-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-dismiss {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.toast-dismiss:hover {
  color: #e0e0e0;
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
