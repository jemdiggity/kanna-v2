// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computed, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@kanna/agent-protocol";
import { createPinia, setActivePinia } from "pinia";
import AgentMessageView from "../AgentMessageView.vue";
import type { JournaledAgentEvent } from "../../composables/useAgentStream";
import { useKannaStore } from "../../stores/kanna";

const sendInput = vi.fn();
const sendPermission = vi.fn();
const interrupt = vi.fn();
const setModel = vi.fn();
const events = ref<JournaledAgentEvent[]>([]);
const error = ref<string | null>(null);

vi.mock("../../composables/useAgentStream", () => ({
  useAgentStream: () => ({
    events,
    connected: ref(true),
    ready: ref(true),
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
    setModel,
    close: vi.fn(),
  }),
}));

const slashCommands = [
  { name: "review", description: "Review the diff", source: "project" as const },
  { name: "refactor", description: "Refactor a file", source: "user" as const },
  { name: "commit", description: "Commit and PR", source: "project" as const },
];
vi.mock("../../composables/useSlashCommands", () => ({
  useSlashCommands: () => ({
    commands: ref(slashCommands),
    filter: (query: string) =>
      query ? slashCommands.filter((command) => command.name.startsWith(query)) : slashCommands,
    reload: vi.fn(),
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
    setModel.mockReset();
    localStorage.clear();
  });

  it("renders using the user appearance preference without local style controls", async () => {
    useKannaStore().agentMessageAppearance = "log";
    events.value = [
      { seq: 1, event: { type: "assistant_text", text: "Hello **agent**", truncated: false } },
      { seq: 2, event: { type: "tool_call", call_id: "tool-1", tool_name: "Bash", input: { command: "pnpm test" } } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    expect(wrapper.get('[data-testid="agent-message-view"]').text()).toContain("Hello agent");
    expect(wrapper.classes()).toContain("skin-log");
    expect(wrapper.find(".style-switcher").exists()).toBe(false);
  });

  it("does not carry a separate light terminal chat palette", () => {
    const source = readFileSync(join(process.cwd(), "src/components/AgentMessageView.css"), "utf8");

    expect(source).not.toContain(".skin-terminal.theme-light");
  });

  it("uses shared terminal chat CSS tokens instead of local palette literals", () => {
    const source = readFileSync(join(process.cwd(), "src/components/AgentMessageView.css"), "utf8");
    const terminalSkin = source.match(/\.skin-terminal\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

    expect(terminalSkin).toContain("--agent-bg: var(--kn-agent-terminal-bg)");
    expect(terminalSkin).toContain("--agent-text: var(--kn-agent-terminal-text)");
    expect(terminalSkin).toContain("--agent-accent: var(--kn-agent-terminal-accent)");
    expect(terminalSkin).not.toMatch(/--agent-(?:bg|panel|panel-raised|border|text|muted|accent):\s*#[0-9a-f]{6}/i);
  });

  it("uses one dual-use button: send when idle, stop while running", async () => {
    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });

    // Idle: only the send button is shown.
    expect(wrapper.find(".send-button").exists()).toBe(true);
    expect(wrapper.find(".stop-button").exists()).toBe(false);

    await wrapper.get('[data-testid="agent-composer"]').setValue("Please continue");
    await wrapper.get('[data-testid="agent-composer"]').trigger("keydown", { key: "Enter" });
    expect(sendInput).toHaveBeenCalledWith("Please continue");

    // Running (turn started, not completed): the same button becomes Stop.
    events.value = [{ seq: 1, event: { type: "turn_started", model: null } }];
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".send-button").exists()).toBe(false);
    await wrapper.get(".stop-button").trigger("click");
    expect(interrupt).toHaveBeenCalled();
  });

  it("focuses the composer when a chat agent task is selected", async () => {
    const wrapper = mount(AgentMessageView, {
      attachTo: document.body,
      props: { sessionId: "task-1" },
    });

    await nextTick();

    expect(document.activeElement).toBe(wrapper.get('[data-testid="agent-composer"]').element);

    wrapper.unmount();
  });

  it("prevents the send button from taking focus away from the composer", async () => {
    const wrapper = mount(AgentMessageView, {
      attachTo: document.body,
      props: { sessionId: "task-1" },
    });
    const composer = wrapper.get('[data-testid="agent-composer"]');
    const sendButton = wrapper.get(".send-button");

    await composer.setValue("Keep me focused");
    (composer.element as HTMLTextAreaElement).focus();
    expect(document.activeElement).toBe(composer.element);

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    sendButton.element.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    await sendButton.trigger("click");

    expect(sendInput).toHaveBeenCalledWith("Keep me focused");
    expect(document.activeElement).toBe(composer.element);

    wrapper.unmount();
  });

  it("prevents the stop button from taking focus away from the composer", async () => {
    events.value = [{ seq: 1, event: { type: "turn_started", model: null } }];
    const wrapper = mount(AgentMessageView, {
      attachTo: document.body,
      props: { sessionId: "task-1" },
    });
    const composer = wrapper.get('[data-testid="agent-composer"]');
    const stopButton = wrapper.get(".stop-button");

    (composer.element as HTMLTextAreaElement).focus();
    expect(document.activeElement).toBe(composer.element);

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    stopButton.element.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    await stopButton.trigger("click");

    expect(interrupt).toHaveBeenCalled();
    expect(document.activeElement).toBe(composer.element);

    wrapper.unmount();
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

  it("hides tool, result, and debug plumbing from the conversation", () => {
    events.value = [
      { seq: 1, event: { type: "assistant_text", text: "Working on it", truncated: false } },
      { seq: 2, event: { type: "tool_call", call_id: "tool-1", tool_name: "Bash", input: { command: "pnpm test" } } },
      { seq: 3, event: { type: "tool_result", call_id: "tool-1", output: "secret-output", truncated: false, is_error: false } },
      { seq: 4, event: { type: "raw", line: "{\"provider\":\"line\"}", truncated: false } },
      { seq: 5, event: { type: "diagnostic", message: "stderr output" } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });
    const text = wrapper.get('[data-testid="agent-message-view"]').text();

    expect(text).toContain("Working on it");
    expect(wrapper.find(".tool-card").exists()).toBe(false);
    expect(wrapper.find(".debug-events").exists()).toBe(false);
    expect(text).not.toContain("pnpm test");
    expect(text).not.toContain("secret-output");
    expect(text).not.toContain("stderr output");
  });

  it("renders direct image links as inline previews while keeping the link clickable", () => {
    const imageUrl = "https://example.com/artifacts/screenshot.png";
    events.value = [
      { seq: 1, event: { type: "assistant_text", text: `Screenshot: ${imageUrl}`, truncated: false } },
    ];

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });
    const preview = wrapper.get(".agent-image-link-preview");
    const image = preview.get("img");
    const links = preview.findAll("a");

    expect(image.attributes("src")).toBe(imageUrl);
    expect(image.attributes("loading")).toBe("lazy");
    expect(links.map((link) => link.attributes("href"))).toEqual([imageUrl, imageUrl]);
  });

  it("dispatches image preview activation when an inline image preview link is clicked", async () => {
    const imageUrl = "https://example.com/artifacts/screenshot.png";
    events.value = [
      { seq: 1, event: { type: "assistant_text", text: `Screenshot: ${imageUrl}`, truncated: false } },
    ];
    const activations: unknown[] = [];
    document.addEventListener("image-link-activate", (event) => {
      activations.push((event as CustomEvent).detail);
    }, { once: true });

    const wrapper = mount(AgentMessageView, { props: { sessionId: "task-1" } });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    wrapper.get(".agent-image-link-preview-media").element.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(activations).toEqual([{ url: imageUrl }]);
  });

  it("opens a slash command menu and completes the selected command without sending", async () => {
    const wrapper = mount(AgentMessageView, {
      props: { sessionId: "task-1", agentProvider: "claude", worktreePath: "/w" },
    });

    await wrapper.get('[data-testid="agent-composer"]').setValue("/re");
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(true);
    expect(wrapper.findAll(".slash-item .slash-name").map((node) => node.text())).toEqual([
      "/review",
      "/refactor",
    ]);

    const composer = wrapper.get('[data-testid="agent-composer"]');
    await composer.trigger("keydown", { key: "ArrowDown" });
    await composer.trigger("keydown", { key: "Enter" });

    expect((composer.element as HTMLTextAreaElement).value).toBe("/refactor ");
    expect(sendInput).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="slash-menu"]').exists()).toBe(false);
  });

  it("defaults to the best model and switches on user selection", async () => {
    const wrapper = mount(AgentMessageView, {
      props: { sessionId: "task-1", agentProvider: "claude" },
    });

    // Defaults to the best (first) model without the user picking anything.
    const select = wrapper.get('[data-testid="model-select"]');
    expect((select.element as HTMLSelectElement).value).toBe("claude-opus-4-8");
    expect(setModel).not.toHaveBeenCalled();

    await select.setValue("claude-haiku-4-5-20251001");
    expect(setModel).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
  });
});
