// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiffModal from "../DiffModal.vue";
import { clearContextShortcuts, resetContext } from "../../composables/useShortcutContext";

const storeMocks = vi.hoisted(() => ({
  advanceStage: vi.fn<() => Promise<"held" | "advanced">>(),
  overrideApprovalHold: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../stores/kanna", () => ({
  useKannaStore: () => storeMocks,
}));

vi.mock("../DiffView.vue", () => ({
  default: {
    name: "DiffView",
    template: '<div class="diff-view-stub" />',
    methods: { dismissReviewLayer: () => true },
  },
}));

describe("DiffModal approval override", () => {
  afterEach(() => {
    storeMocks.advanceStage.mockReset();
    storeMocks.overrideApprovalHold.mockReset();
    clearContextShortcuts("diff");
    resetContext();
    document.body.innerHTML = "";
  });

  it("opens and focuses the held composer, validates/cancels, then records and retries approval", async () => {
    storeMocks.advanceStage
      .mockResolvedValueOnce("held")
      .mockResolvedValueOnce("held")
      .mockResolvedValueOnce("advanced");
    storeMocks.overrideApprovalHold.mockResolvedValue(true);
    const wrapper = mount(DiffModal, {
      attachTo: document.body,
      props: {
        repoPath: "/repo",
        taskId: "task-held",
        reviewStage: "pr",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    try {
      await wrapper.get(".verdict-bar .approve").trigger("click");
      await nextTick();
      const firstComposer = wrapper.get(".approval-override-composer");
      expect(document.activeElement).toBe(firstComposer.get("textarea").element);
      expect(firstComposer.get(".primary").attributes("disabled")).toBeDefined();

      await firstComposer.get("button:not(.primary)").trigger("click");
      expect(wrapper.find(".approval-override-composer").exists()).toBe(false);
      expect(storeMocks.overrideApprovalHold).not.toHaveBeenCalled();

      await wrapper.get(".verdict-bar .approve").trigger("click");
      const composer = wrapper.get(".approval-override-composer");
      await composer.get("textarea").setValue("Reviewed the failed lineage with the operator.");
      await composer.get(".primary").trigger("click");
      await vi.waitFor(() => expect(storeMocks.advanceStage).toHaveBeenCalledTimes(3));

      expect(storeMocks.overrideApprovalHold).toHaveBeenCalledWith(
        "task-held",
        "Reviewed the failed lineage with the operator.",
      );
      expect(wrapper.find(".approval-override-composer").exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
