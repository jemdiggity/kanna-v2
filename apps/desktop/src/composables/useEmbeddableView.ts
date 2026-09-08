import { computed, nextTick, watch, type Ref } from "vue";

import { useModalZIndex } from "./useModalZIndex";
import { useShortcutContext, type ShortcutContext } from "./useShortcutContext";

/**
 * The two props every view that can be either an overlay or a main-area tab
 * carries. `active` is meaningful only while `embedded`: it says whether this
 * is the tab in front, which a view needs to know when it owns window-level
 * keys, a terminal, or focus.
 */
export interface EmbeddableViewProps {
  embedded?: boolean;
  active?: boolean;
}

/**
 * Shared wiring for a view that renders as an overlay *or* inline as a tab.
 *
 * Every one of these views is the same shape — a `.modal-overlay` root with a
 * modal z-index, a shortcut context and a click-outside dismiss — and all
 * three are wrong when the view is a tab: a tab is not above the modals a user
 * opened over it, the context follows the active tab rather than the mounted
 * component, and there is no outside to click. Rather than repeat that
 * reasoning in eight components, it lives here.
 */
export function useEmbeddableView(
  props: EmbeddableViewProps,
  options: { context?: ShortcutContext } = {},
): {
  zIndex: Ref<number>;
  bringToFront: () => void;
  isForeground: () => boolean;
  overlayClass: Ref<Record<string, boolean>>;
  overlayStyle: Ref<{ zIndex: number } | undefined>;
  dismissOnScrimClick: (dismiss: () => void) => void;
  focusWhenBrought: (element: Ref<HTMLElement | null>) => void;
} {
  if (!props.embedded && options.context) useShortcutContext(options.context);

  const { zIndex, bringToFront } = useModalZIndex({ enabled: !props.embedded });

  return {
    zIndex,
    bringToFront,
    /** False while another tab is in front of this embedded view. */
    isForeground: () => !(props.embedded === true && props.active === false),
    /**
     * The root's classes. An embedded view drops `modal-overlay` entirely
     * rather than overriding it: those rules belong to a thing with a scrim
     * that centres a fixed-size box in the viewport, and a tab is none of
     * that. It keeps `embedded` so each view can size its own inner box.
     */
    overlayClass: computed(() => ({
      "modal-overlay": props.embedded !== true,
      "embedded-view": props.embedded === true,
      embedded: props.embedded === true,
    })),
    overlayStyle: computed(() => (props.embedded ? undefined : { zIndex: zIndex.value })),
    /** A tab has no scrim, so a click on its root must not close it. */
    dismissOnScrimClick: (dismiss: () => void) => {
      if (!props.embedded) dismiss();
    },
    /**
     * Take keyboard focus when this view becomes the tab in front. A modal
     * took focus by appearing; a tab has to take it when it is brought
     * forward, or the keys it owns land on whatever had focus before.
     */
    focusWhenBrought: (element: Ref<HTMLElement | null>) => {
      watch(
        () => props.active,
        (active) => {
          if (!props.embedded || !active) return;
          void nextTick(() => element.value?.focus());
        },
      );
    },
  };
}
