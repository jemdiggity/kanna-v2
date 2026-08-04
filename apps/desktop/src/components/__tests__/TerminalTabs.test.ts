// @vitest-environment happy-dom

import { defineComponent, h, onActivated, onDeactivated, onMounted, onUnmounted } from "vue"
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import TerminalTabs from "../TerminalTabs.vue"

describe("TerminalTabs", () => {
  it("passes agent and protected-operator input modes to PTY terminals", () => {
    const wrapper = mount(TerminalTabs, {
      props: {
        sessionId: "agent-1",
        agentType: "pty",
        worktreePath: "/tmp/task",
        operatorTerminalInput: true,
      },
      global: {
        stubs: {
          TerminalView: {
            name: "TerminalView",
            props: ["agentTerminal", "operatorTerminalInput"],
            template: "<div class='terminal-view-stub' />",
          },
          AgentMessageView: true,
        },
      },
    })

    expect(wrapper.findComponent({ name: "TerminalView" }).props("agentTerminal")).toBe(true)
    expect(wrapper.findComponent({ name: "TerminalView" }).props("operatorTerminalInput")).toBe(true)
  })

  it("keeps recently viewed PTY terminals warm across task switches", async () => {
    const lifecycle = vi.fn<(event: string, sessionId: string) => void>()

    const TerminalViewStub = defineComponent({
      name: "TerminalView",
      props: {
        sessionId: {
          type: String,
          required: true,
        },
      },
      setup(props) {
        onMounted(() => lifecycle("mounted", props.sessionId))
        onActivated(() => lifecycle("activated", props.sessionId))
        onDeactivated(() => lifecycle("deactivated", props.sessionId))
        onUnmounted(() => lifecycle("unmounted", props.sessionId))

        return () => h("div", { class: "terminal-view-stub" }, props.sessionId)
      },
    })

    const wrapper = mount(TerminalTabs, {
      props: {
        sessionId: "agent-1",
        agentType: "pty",
        worktreePath: "/tmp/task",
      },
      global: {
        stubs: {
          TerminalView: TerminalViewStub,
          AgentMessageView: true,
        },
      },
    })

    expect(lifecycle.mock.calls).toEqual([
      ["mounted", "agent-1"],
      ["activated", "agent-1"],
    ])

    await wrapper.setProps({ sessionId: "agent-2" })
    await wrapper.setProps({ sessionId: "agent-1" })

    expect(lifecycle.mock.calls).toEqual([
      ["mounted", "agent-1"],
      ["activated", "agent-1"],
      ["deactivated", "agent-1"],
      ["mounted", "agent-2"],
      ["activated", "agent-2"],
      ["deactivated", "agent-2"],
      ["activated", "agent-1"],
    ])
  })

  it("evicts the least recently used warm PTY terminal once the cache is full", async () => {
    const lifecycle = vi.fn<(event: string, sessionId: string) => void>()

    const TerminalViewStub = defineComponent({
      name: "TerminalView",
      props: {
        sessionId: {
          type: String,
          required: true,
        },
      },
      setup(props) {
        onMounted(() => lifecycle("mounted", props.sessionId))
        onActivated(() => lifecycle("activated", props.sessionId))
        onDeactivated(() => lifecycle("deactivated", props.sessionId))
        onUnmounted(() => lifecycle("unmounted", props.sessionId))
        return () => h("div", { class: "terminal-view-stub" }, props.sessionId)
      },
    })

    const wrapper = mount(TerminalTabs, {
      props: {
        sessionId: "agent-1",
        agentType: "pty",
        worktreePath: "/tmp/task",
      },
      global: {
        stubs: {
          TerminalView: TerminalViewStub,
          AgentMessageView: true,
        },
      },
    })

    for (let index = 2; index <= 11; index += 1) {
      await wrapper.setProps({ sessionId: `agent-${index}` })
    }

    expect(lifecycle.mock.calls).toContainEqual(["unmounted", "agent-1"])
  })
})
