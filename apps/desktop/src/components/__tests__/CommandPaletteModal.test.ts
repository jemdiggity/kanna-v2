// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CommandPaletteModal from "../CommandPaletteModal.vue";
import { shortcuts } from "../../composables/useKeyboardShortcuts";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function paletteLabels() {
  const wrapper = mount(CommandPaletteModal, { attachTo: document.body });
  const labels = wrapper.findAll(".command-label").map((label) => label.text());
  wrapper.unmount();
  return labels;
}

describe("CommandPaletteModal", () => {
  it("omits shortcuts that cannot act from the palette", () => {
    const labels = paletteLabels();

    // Tab cycling only applies inside a tabbed modal, which is closed while the
    // palette is open; the palette itself is the commandPalette/dismiss action.
    expect(labels).not.toContain("shortcuts.prevTab");
    expect(labels).not.toContain("shortcuts.nextTab");
    expect(labels).not.toContain("shortcuts.commandPalette");
    expect(labels).not.toContain("shortcuts.dismiss");
  });

  it("lists every other shortcut, including ones hidden from the shortcuts modal", () => {
    const labels = paletteLabels();

    for (const shortcut of shortcuts) {
      if (shortcut.paletteHidden) continue;
      expect(labels, shortcut.action).toContain(shortcut.labelKey);
    }
    expect(labels).toContain("shortcuts.allShortcuts");
  });
});
