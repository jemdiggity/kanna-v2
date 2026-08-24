// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MentionedFilesOverlay from "../MentionedFilesOverlay.vue";

describe("MentionedFilesOverlay", () => {
  it("opens available rows and disables unavailable rows with their reason", async () => {
    const wrapper = mount(MentionedFilesOverlay, {
      props: {
        loading: false,
        error: null,
        overflow: false,
        rows: [
          { path: "src/app.ts", line: 7, available: true },
          {
            path: "/tmp/kanna-verification.png",
            available: false,
            unavailableReason: "Outside the remote task workspace",
          },
        ],
      },
    });

    const available = wrapper.get('[data-testid="mentioned-file-available"]');
    const unavailable = wrapper.get('[data-testid="mentioned-file-unavailable"]');
    expect(available.text()).toContain("app.ts:7");
    expect(unavailable.attributes("disabled")).toBeDefined();
    expect(unavailable.text()).toContain(
      "Unavailable · Outside the remote task workspace",
    );

    await available.trigger("click");
    await unavailable.trigger("click");
    expect(wrapper.emitted("open")).toEqual([[0]]);
  });
});
