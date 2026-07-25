import { WebDriverClient } from "./webdriver";

export interface DragSortableOptions {
  /**
   * Vertical offset of the drop point as a fraction of the target height,
   * relative to the target center. SortableJS resolves a cross-list hover
   * over an item by which side of the item's center the pointer is on and
   * treats the exact center as no-op, so cross-list drops onto an item
   * should bias off-center (e.g. 0.25 to land in the lower half).
   */
  targetVerticalBias?: number;
}

/**
 * Drive a SortableJS (vuedraggable) drag from one sidebar element onto another
 * with synthetic pointer/mouse events. The drop lands at the center of the
 * target element (adjustable via targetVerticalBias), which SortableJS
 * interprets as a list insertion at that position.
 */
export async function dragSortableTaskToTarget(
  client: WebDriverClient,
  sourceSelector: string,
  targetSelector: string,
  options: DragSortableOptions = {},
): Promise<void> {
  const targetVerticalBias = options.targetVerticalBias ?? 0;
  const result = await client.executeAsync<string | { __error: string }>(
    `const cb = arguments[arguments.length - 1];
     const source = document.querySelector(${JSON.stringify(sourceSelector)});
     let target = document.querySelector(${JSON.stringify(targetSelector)});
     if (!source) {
       cb({ __error: "source not found: " + ${JSON.stringify(sourceSelector)} });
       return;
     }
     if (!target) {
       cb({ __error: "target not found: " + ${JSON.stringify(targetSelector)} });
       return;
     }

     const sourceRect = source.getBoundingClientRect();
     const start = {
       x: Math.round(sourceRect.left + sourceRect.width / 2),
       y: Math.round(sourceRect.top + sourceRect.height / 2),
     };
     const activationPoint = { x: start.x, y: start.y + 18 };
     const pointerId = 33;

     function pointer(type, point, buttons) {
       const init = {
         view: window,
         bubbles: true,
         cancelable: true,
         pointerId,
         pointerType: "mouse",
         isPrimary: true,
         clientX: point.x,
         clientY: point.y,
         screenX: point.x,
         screenY: point.y,
         button: 0,
         buttons,
       };
       if (typeof PointerEvent === "function") return new PointerEvent(type, init);
       const event = new MouseEvent(type, init);
       Object.defineProperties(event, {
         pointerId: { value: pointerId },
         pointerType: { value: "mouse" },
         isPrimary: { value: true },
       });
       return event;
     }

     function mouse(type, point, buttons) {
       const event = new MouseEvent(type, {
         view: window,
         bubbles: true,
         cancelable: true,
         clientX: point.x,
         clientY: point.y,
         screenX: point.x,
         screenY: point.y,
         button: 0,
         buttons,
       });
       Object.defineProperty(event, "which", { value: buttons ? 1 : 0 });
       return event;
     }

     function dispatch(type, point, buttons, explicitTarget) {
       const element = explicitTarget || document.elementFromPoint(point.x, point.y) || document.body;
       if (type.startsWith("pointer")) {
         element.dispatchEvent(pointer(type, point, buttons));
         document.dispatchEvent(pointer(type, point, buttons));
       } else {
         element.dispatchEvent(mouse(type, point, buttons));
         document.dispatchEvent(mouse(type, point, buttons));
       }
     }

     dispatch("pointermove", start, 0, source);
     dispatch("mousemove", start, 0, source);
     dispatch("pointerdown", start, 1, source);
     dispatch("mousedown", start, 1, source);
     setTimeout(() => {
       dispatch("pointermove", activationPoint, 1);
       dispatch("mousemove", activationPoint, 1);
       setTimeout(() => {
         const targetDeadline = Date.now() + 1_000;
         const dropWhenTargetIsReady = () => {
           target = document.querySelector(${JSON.stringify(targetSelector)});
           const targetRect = target?.getBoundingClientRect();
           if (!targetRect || targetRect.width === 0 || targetRect.height === 0) {
             if (Date.now() < targetDeadline) {
               setTimeout(dropWhenTargetIsReady, 40);
               return;
             }
             dispatch("pointerup", activationPoint, 0);
             dispatch("mouseup", activationPoint, 0);
             setTimeout(() => cb({
               __error: "target has no drop area after drag activation: " + ${JSON.stringify(targetSelector)},
             }), 200);
             return;
           }
           const end = {
             x: Math.round(targetRect.left + targetRect.width / 2),
             y: Math.round(targetRect.top + targetRect.height * (0.5 + ${JSON.stringify(targetVerticalBias)})),
           };
           const points = [
             { x: Math.round((activationPoint.x + end.x) / 2), y: Math.round((activationPoint.y + end.y) / 2) },
             end,
           ];
           let index = 0;
           const tick = () => {
             if (index < points.length) {
               dispatch("pointermove", points[index], 1);
               dispatch("mousemove", points[index], 1);
               index += 1;
               setTimeout(tick, 120);
               return;
             }
             dispatch("pointerup", end, 0);
             dispatch("mouseup", end, 0);
             setTimeout(() => cb("ok"), 200);
           };
           tick();
         };
         dropWhenTargetIsReady();
       }, 180);
     }, 120);`,
  );

  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(result.__error);
  }
}
