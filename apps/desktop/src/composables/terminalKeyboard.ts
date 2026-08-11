export const SHIFT_ENTER_CSI_U = "\x1b[13;2u"

export function isShiftEnter(event: KeyboardEvent): boolean {
  return event.type === "keydown"
    && event.key === "Enter"
    && event.shiftKey
    && !event.metaKey
    && !event.altKey
    && !event.ctrlKey
}
