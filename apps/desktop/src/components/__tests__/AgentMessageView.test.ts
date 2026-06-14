// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@kanna/agent-protocol";
import { createPinia, setActivePinia } from "pinia";
import AgentMessageView from "../AgentMessageView.vue";
import type { JournaledAgentEvent } from "../../composables/useAgentStream";
import { useKannaStore } from "../../stores/kanna";

const sendInput = vi.fn();
const sendPermission = vi.fn();
const interrupt = vi.fn();
const events = ref<JournaledAgentEvent[]>([]);
const error = ref<string | null>(null);

vi.mock("../../composables/useAgentStream", () => ({
  useAgentStream: () => ({
    events,
    connected: ref(true),
    ended: ref(false),
    error,
    pendingPermissions: computed(() =>
      events.value
        .map((item) => item.event)
        .filter((event): event is Extract<AgentEvent, { type: "permission_request" }> => event.type === "permission_request"),
    ),
    sendInput,
    sendPermission,
    interrupt,
    close: vi.fn(),
  }),
}));

describe("AgentMessageView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    events.value = [];
    error.value = null;
    sendInput.mockReset();
    sendPermission.mockReset();
    interrupt.mockReset();
    localStorage.clear();
  });

  it("renders events in all three styles", async () => {
    events.value = [
      { seq: 1, event: { type: "assistant_text", text: "Hello **agent**", truncated: false } },
      { seq: 2, event: { type: "tool_call", call_id: "tool-1", tool_name: "Bash", input: { command: "pnpm test" } } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    expect(wrapper.get('[data-testid="agent-message-view"]').text()).toContain("Hello agent");
    expect(wrapper.classes()).toContain("skin-chat");

    await wrapper.get(".style-switcher button:nth-child(2)").trigger("click");
    expect(wrapper.classes()).toContain("skin-log");

    await wrapper.get(".style-switcher button:nth-child(3)").trigger("click");
    expect(wrapper.classes()).toContain("skin-terminal");
    expect(useKannaStore().agentMessageStyle).toBe("terminal");
  });

  it("sends composer input and interrupts", async () => {
    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    await wrapper.get('[data-testid="agent-composer"]').setValue("Please continue");
    await wrapper.get('[data-testid="agent-composer"]').trigger("keydown", { key: "Enter" });
    expect(sendInput).toHaveBeenCalledWith("Please continue");

    await wrapper.get(".stop-button").trigger("click");
    expect(interrupt).toHaveBeenCalled();
  });

  it("renders permission requests and sends decisions", async () => {
    events.value = [
      { seq: 1, event: { type: "permission_request", request_id: "perm-1", tool_name: "Bash", input: { command: "rm file" } } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    await wrapper.get('[data-testid="permission-reason-perm-1"]').setValue("No destructive command");
    await wrapper.findAll(".permission-actions button")[0].trigger("click");
    expect(sendPermission).toHaveBeenCalledWith("perm-1", { kind: "allow" });

    await wrapper.findAll(".permission-actions button")[2].trigger("click");
    expect(sendPermission).toHaveBeenCalledWith("perm-1", { kind: "deny", reason: "No destructive command" });
  });

  it("keeps raw and diagnostic events collapsed under debug", () => {
    events.value = [
      { seq: 1, event: { type: "raw", line: "{\"provider\":\"line\"}", truncated: false } },
      { seq: 2, event: { type: "diagnostic", message: "stderr output" } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    expect(wrapper.get(".debug-events").text()).toContain("stderr output");
  });
});
