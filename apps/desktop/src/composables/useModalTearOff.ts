import { inject, ref, type Ref } from "vue";
import type { ModalTearOffContext, ModalTearOffDragOrigin } from "../modalTearOff";
import { resolveModalTearOffGeometry } from "../modalTearOff";
import type { WindowWorkspaceController } from "../windowWorkspace";

const DRAG_THRESHOLD_PX = 8;
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, [role='button'], [data-no-tear-off]";

interface UseModalTearOffOptions {
  enabled: Ref<boolean>;
  modalRef: Ref<HTMLElement | null>;
  handleSelector: string;
  getContext: () => ModalTearOffContext;
  onTornOff: () => void;
  openWindow?: (context: ModalTearOffContext, geometry: ReturnType<typeof resolveModalTearOffGeometry>) => Promise<void>;
}

interface ActiveDrag {
  pointerId: number;
  origin: ModalTearOffDragOrigin;
  deltaX: number;
  deltaY: number;
}

function eventTargetElement(event: PointerEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function setPointerCaptureSafely(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch (error) {
    // Synthetic pointer events used by the desktop WebDriver bridge do not
    // have an active native pointer, but still exercise the same handlers.
    console.debug("[modalTearOff] pointer capture unavailable:", error);
  }
}

function releasePointerCaptureSafely(element: HTMLElement | null, pointerId: number): void {
  try {
    element?.releasePointerCapture(pointerId);
  } catch (error) {
    // The capture can already be gone after native cancellation/window blur.
    console.debug("[modalTearOff] pointer capture already released:", error);
  }
}

export function useModalTearOff(options: UseModalTearOffOptions) {
  const windowWorkspace = options.openWindow
    ? null
    : inject<WindowWorkspaceController>("windowWorkspace");
  const activeDrag = ref<ActiveDrag | null>(null);
  const opening = ref(false);

  function resetDrag(): void {
    activeDrag.value = null;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!options.enabled.value || opening.value || event.button !== 0) return;
    const target = eventTargetElement(event);
    const modal = options.modalRef.value;
    if (!target || !modal || !target.closest(options.handleSelector) || target.closest(INTERACTIVE_SELECTOR)) {
      return;
    }

    const rect = modal.getBoundingClientRect();
    activeDrag.value = {
      pointerId: event.pointerId,
      origin: {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        modalLeft: rect.left,
        modalTop: rect.top,
        modalWidth: rect.width,
        modalHeight: rect.height,
      },
      deltaX: 0,
      deltaY: 0,
    };
    setPointerCaptureSafely(modal, event.pointerId);
  }

  function beginTearOff(event: PointerEvent, drag: ActiveDrag): void {
    releasePointerCaptureSafely(options.modalRef.value, event.pointerId);
    const context = options.getContext();
    const geometry = resolveModalTearOffGeometry(drag.origin, event);
    opening.value = true;
    resetDrag();
    void (async () => {
      try {
        if (options.openWindow) {
          await options.openWindow(context, geometry);
        } else if (windowWorkspace) {
          await windowWorkspace.openTearOffWindow(context, geometry);
        } else {
          throw new Error("window workspace is unavailable");
        }
        options.onTornOff();
      } catch (error) {
        console.error("[modalTearOff] failed to open detached window:", error);
      } finally {
        opening.value = false;
      }
    })();
  }

  function onPointerMove(event: PointerEvent): void {
    const drag = activeDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.deltaX = event.clientX - drag.origin.clientX;
    drag.deltaY = event.clientY - drag.origin.clientY;
    if (Math.hypot(drag.deltaX, drag.deltaY) >= DRAG_THRESHOLD_PX) {
      event.preventDefault();
      beginTearOff(event, drag);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const drag = activeDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) return;
    releasePointerCaptureSafely(options.modalRef.value, event.pointerId);
    resetDrag();
  }

  function onPointerCancel(event: PointerEvent): void {
    if (activeDrag.value?.pointerId !== event.pointerId) return;
    releasePointerCaptureSafely(options.modalRef.value, event.pointerId);
    resetDrag();
  }

  return {
    opening,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
