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
  it("omits only the shortcuts whose action is the palette itself", () => {
    const labels = paletteLabels();

    expect(labels).not.toContain("shortcuts.commandPalette");
    expect(labels).not.toContain("shortcuts.dismiss");
  });

  it("lists tab cycling, which dispatches to the Preferences panel beneath the palette", () => {
    const labels = paletteLabels();

    expect(labels).toContain("shortcuts.prevTab");
    expect(labels).toContain("shortcuts.nextTab");
  });

  it("lists every other shortcut, including ones hidden from the shortcuts modal", () => {
    const labels = paletteLabels();

    for (const shortcut of shortcuts) {
      if (shortcut.paletteHidden) continue;
      expect(labels, shortcut.action).toContain(shortcut.labelKey);
    }
    expect(labels).toContain("shortcuts.allShortcuts");
  });

  it("lists undo close as a command without assigning it a shortcut", async () => {
    const wrapper = mount(CommandPaletteModal, {
      attachTo: document.body,
      props: {
        extraCommands: [{
          action: "undoClose",
          label: "tasks.undoClose",
          group: "shortcuts.groupTasks",
          shortcut: "",
        }],
      },
    });
    const command = wrapper.findAll(".command-item")
      .find((item) => item.find(".command-label").text() === "tasks.undoClose");

    expect(command).toBeDefined();
    expect(command?.find(".command-keys").exists()).toBe(false);
    await command?.trigger("click");
    expect(wrapper.emitted("execute")).toContainEqual(["undoClose"]);
    wrapper.unmount();
  });
});
