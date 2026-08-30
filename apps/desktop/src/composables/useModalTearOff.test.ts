import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModalTearOff } from "./useModalTearOff";

const openWindowMock = vi.hoisted(() => vi.fn(async () => undefined));

const Harness = defineComponent({
  setup() {
    const modalRef = ref<HTMLElement | null>(null);
    const closed = ref(false);
    const tearOff = useModalTearOff({
      enabled: ref(true),
      modalRef,
      handleSelector: ".header",
      getContext: () => ({
        surface: "tree",
        worktreePath: "/repo",
        repoRoot: "/repo",
      }),
      onTornOff: () => {
        closed.value = true;
      },
      openWindow: openWindowMock,
    });
    return { modalRef, closed, tearOff };
  },
  template: `
    <div
      ref="modalRef"
      class="modal"
      @pointerdown="tearOff.onPointerDown"
      @pointermove="tearOff.onPointerMove"
      @pointerup="tearOff.onPointerUp"
      @pointercancel="tearOff.onPointerCancel"
    >
      <div class="header"><span>Drag</span><button>Action</button></div>
      <div class="content">Content</div>
    </div>
  `,
});

function prepareModal(element: HTMLElement): void {
  element.getBoundingClientRect = () => ({
    x: 100,
    y: 80,
    left: 100,
    top: 80,
    right: 880,
    bottom: 600,
    width: 780,
    height: 520,
    toJSON: () => ({}),
  });
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
}

describe("useModalTearOff", () => {
  beforeEach(() => {
    openWindowMock.mockClear();
  });

  it("keeps header clicks and sub-threshold movement in the modal", async () => {
    const wrapper = mount(Harness);
    prepareModal(wrapper.get(".modal").element as HTMLElement);

    await wrapper.get(".header span").trigger("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 180,
      clientY: 100,
      screenX: 580,
      screenY: 200,
    });
    await wrapper.get(".modal").trigger("pointermove", {
      pointerId: 1,
      clientX: 185,
      clientY: 103,
      screenX: 585,
      screenY: 203,
    });
    await wrapper.get(".modal").trigger("pointerup", {
      pointerId: 1,
      clientX: 185,
      clientY: 103,
      screenX: 585,
      screenY: 203,
    });

    expect(openWindowMock).not.toHaveBeenCalled();
    expect(wrapper.vm.closed).toBe(false);
  });

  it("opens as soon as movement crosses the threshold and then closes the modal", async () => {
    const wrapper = mount(Harness);
    prepareModal(wrapper.get(".modal").element as HTMLElement);

    await wrapper.get(".header span").trigger("pointerdown", {
      button: 0,
      pointerId: 2,
      clientX: 180,
      clientY: 100,
      screenX: 580,
      screenY: 200,
    });
    await wrapper.get(".modal").trigger("pointermove", {
      pointerId: 2,
      clientX: 220,
      clientY: 125,
      screenX: 620,
      screenY: 225,
    });
    await Promise.resolve();

    expect(openWindowMock).toHaveBeenCalledWith(
      { surface: "tree", worktreePath: "/repo", repoRoot: "/repo" },
      { x: 540, y: 205, width: 780, height: 520 },
    );
    expect(wrapper.vm.closed).toBe(true);
  });

  it("does not start a tear-off from interactive header controls", async () => {
    const wrapper = mount(Harness);
    prepareModal(wrapper.get(".modal").element as HTMLElement);

    await wrapper.get("button").trigger("pointerdown", {
      button: 0,
      pointerId: 3,
      clientX: 180,
      clientY: 100,
    });
    await wrapper.get(".modal").trigger("pointermove", {
      pointerId: 3,
      clientX: 260,
      clientY: 180,
    });
    await wrapper.get(".modal").trigger("pointerup", {
      pointerId: 3,
      clientX: 260,
      clientY: 180,
    });

    expect(openWindowMock).not.toHaveBeenCalled();
  });
});
