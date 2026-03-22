import { ref } from 'vue'

export interface Toast {
  id: number
  type: 'warning' | 'error'
  message: string
}

const MAX_VISIBLE = 3
const DURATIONS = { warning: 3000, error: 5000 } as const

const toasts = ref<Toast[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 0

function dismiss(id: number) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx !== -1) toasts.value.splice(idx, 1)
}

function add(type: Toast['type'], message: string) {
  const id = nextId++
  const toast: Toast = { id, type, message }

  // Evict oldest if at capacity
  while (toasts.value.length >= MAX_VISIBLE) {
    dismiss(toasts.value[0].id)
  }

  toasts.value.push(toast)
  timers.set(id, setTimeout(() => dismiss(id), DURATIONS[type]))
}

export function useToast() {
  return {
    toasts,
    dismiss,
    warning: (message: string) => add('warning', message),
    error: (message: string) => add('error', message),
  }
}
