// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import ImageUrlPreviewModal from "../ImageUrlPreviewModal.vue";

const invokeMock = vi.fn();

vi.mock("../../invoke", () => ({
  invoke: (...args: [string, Record<string, unknown> | undefined]) => invokeMock(...args),
}));

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

describe("ImageUrlPreviewModal", () => {
  it("renders a remote image URL with a clickable source link and closes", async () => {
    const imageUrl = "https://example.com/artifacts/screenshot.png";

    const wrapper = mount(ImageUrlPreviewModal, {
      props: { imageUrl },
    });

    expect(wrapper.get("img").attributes("src")).toBe(imageUrl);
    expect(wrapper.get("img").attributes("alt")).toBe(imageUrl);
    expect(wrapper.get("a").attributes("href")).toBe(imageUrl);

    await wrapper.get('[aria-label="Close image preview"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("loads absolute local file paths through the backend image reader", async () => {
    const imagePath = "/worktree/simple-paper-boat.png";
    invokeMock.mockResolvedValue("data:image/png;base64,cG5n");

    const wrapper = mount(ImageUrlPreviewModal, {
      props: { imageUrl: imagePath },
    });
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("read_image_file_data_url", { path: imagePath });
    expect(wrapper.get("img").attributes("src")).toBe("data:image/png;base64,cG5n");
    expect(wrapper.get("a").attributes("href")).toBe("data:image/png;base64,cG5n");
    expect(wrapper.get("a").text()).toBe(imagePath);
  });
});
