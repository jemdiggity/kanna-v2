// @vitest-environment happy-dom

import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useAppModals } from "./useAppModals";

describe("useAppModals", () => {
  it("opens and closes remote image URL previews", async () => {
    const TestHarness = defineComponent({
      setup() {
        const modals = useAppModals({
          isMobile: false,
          store: {} as Parameters<typeof useAppModals>[0]["store"],
          windowWorkspace: {
            bootstrap: { windowId: "main" },
            loadSnapshot: vi.fn(),
            persistSidebarWidth: vi.fn(),
          } as unknown as Parameters<typeof useAppModals>[0]["windowWorkspace"],
        });
        return { modals };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);

    wrapper.vm.modals.openImageUrlPreview("https://example.com/screenshot.png");
    expect(wrapper.vm.modals.showImageUrlPreviewModal.value).toBe(true);
    expect(wrapper.vm.modals.previewImageUrl.value).toBe("https://example.com/screenshot.png");

    wrapper.vm.modals.closeImageUrlPreview();
    expect(wrapper.vm.modals.showImageUrlPreviewModal.value).toBe(false);
  });
});
