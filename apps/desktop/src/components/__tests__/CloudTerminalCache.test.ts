// @vitest-environment happy-dom

import { defineComponent, h, nextTick, onMounted, onUnmounted } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CloudTerminalCache, {
  REMOTE_TERMINAL_WARM_CACHE_MAX,
  REMOTE_TERMINAL_WARM_TIMEOUT_MS,
  type CloudTerminalCacheEntry,
} from "../CloudTerminalCache.vue";

function terminal(key: string): CloudTerminalCacheEntry {
  return {
    key,
    ownerDesktopId: "desktop-owner",
    ownerTaskId: `owner-${key}`,
    transport: "lan",
  };
}

function mountCache(
  activeTerminal: CloudTerminalCacheEntry | null,
  lifecycle = vi.fn<(event: string, taskId: string) => void>(),
) {
  const CloudTerminalViewStub = defineComponent({
    name: "CloudTerminalView",
    props: {
      active: {
        type: Boolean,
        required: true,
      },
      ownerTaskId: {
        type: String,
        required: true,
      },
    },
    setup(props) {
      onMounted(() => lifecycle("mounted", props.ownerTaskId));
      onUnmounted(() => lifecycle("unmounted", props.ownerTaskId));
      return () => h("div", {
        class: "cloud-terminal-view-stub",
        "data-owner-task-id": props.ownerTaskId,
      });
    },
  });

  return {
    lifecycle,
    wrapper: mount(CloudTerminalCache, {
      props: { activeTerminal },
      global: {
        stubs: { CloudTerminalView: CloudTerminalViewStub },
      },
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CloudTerminalCache", () => {
  it("keeps recently selected remote terminals mounted across task switches", async () => {
    const { lifecycle, wrapper } = mountCache(terminal("task-a"));
    const firstTerminal = wrapper.get('[data-terminal-cache-key="task-a"]');

    await wrapper.setProps({ activeTerminal: terminal("task-b") });
    expect(wrapper.findAll(".cloud-terminal-view-stub")).toHaveLength(2);
    expect(wrapper.get('[data-terminal-cache-key="task-a"]').attributes("style")).toContain("display: none");
    const cachedViews = wrapper.findAllComponents({ name: "CloudTerminalView" });
    expect(cachedViews.find((view) => view.props("ownerTaskId") === "owner-task-a")?.props("active")).toBe(false);
    expect(cachedViews.find((view) => view.props("ownerTaskId") === "owner-task-b")?.props("active")).toBe(true);

    await wrapper.setProps({ activeTerminal: terminal("task-a") });

    expect(wrapper.get('[data-terminal-cache-key="task-a"]').element).toBe(firstTerminal.element);
    expect(wrapper.findAllComponents({ name: "CloudTerminalView" })
      .find((view) => view.props("ownerTaskId") === "owner-task-a")
      ?.props("active")).toBe(true);
    expect(lifecycle.mock.calls).toEqual([
      ["mounted", "owner-task-a"],
      ["mounted", "owner-task-b"],
    ]);
  });

  it("evicts the least recently used terminal once the warm cache is full", async () => {
    vi.useFakeTimers();
    const { wrapper } = mountCache(terminal("task-1"));

    for (let index = 2; index <= REMOTE_TERMINAL_WARM_CACHE_MAX; index += 1) {
      await wrapper.setProps({ activeTerminal: terminal(`task-${index}`) });
    }
    await wrapper.setProps({ activeTerminal: terminal("task-1") });
    await wrapper.setProps({ activeTerminal: terminal(`task-${REMOTE_TERMINAL_WARM_CACHE_MAX + 1}`) });

    expect(wrapper.find('[data-terminal-cache-key="task-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-terminal-cache-key="task-2"]').exists()).toBe(false);
    expect(wrapper.findAll(".cloud-terminal-view-stub")).toHaveLength(REMOTE_TERMINAL_WARM_CACHE_MAX);
  });

  it("expires inactive terminals after the warm timeout but never expires the active one", async () => {
    vi.useFakeTimers();
    const { wrapper } = mountCache(terminal("task-a"));

    vi.advanceTimersByTime(REMOTE_TERMINAL_WARM_TIMEOUT_MS * 2);
    await nextTick();
    expect(wrapper.find('[data-terminal-cache-key="task-a"]').exists()).toBe(true);

    await wrapper.setProps({ activeTerminal: terminal("task-b") });
    vi.advanceTimersByTime(REMOTE_TERMINAL_WARM_TIMEOUT_MS - 1);
    await nextTick();
    expect(wrapper.find('[data-terminal-cache-key="task-a"]').exists()).toBe(true);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find('[data-terminal-cache-key="task-a"]').exists()).toBe(false);
    expect(wrapper.find('[data-terminal-cache-key="task-b"]').exists()).toBe(true);
  });

  it("immediately discards a terminal that becomes ineligible for display", async () => {
    const { lifecycle, wrapper } = mountCache(terminal("task-blocked"));

    await wrapper.setProps({
      activeTerminal: null,
      discardKey: "task-blocked",
    });

    expect(wrapper.find('[data-terminal-cache-key="task-blocked"]').exists()).toBe(false);
    expect(lifecycle).toHaveBeenCalledWith("unmounted", "owner-task-blocked");
  });
});
