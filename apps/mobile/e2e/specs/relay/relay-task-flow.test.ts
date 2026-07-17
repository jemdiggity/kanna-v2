import { describe, expect, it, vi } from "vitest";
import { assertSingleSubmittedTaskInput } from "../../helpers/relay-harness";
import {
  assertRelayTaskRowPresentation,
  inspectTaskFilePreviewWebView,
  openRelayFixtureTask,
  verifyRelayTaskActionMenuJourney,
  verifyRelayQuickReplyJourney,
  verifyRelayTaskActivityTransitions,
  verifyRelayTaskMarkedRead,
  verifyTerminalMarkdownFileControls,
  type RelayTaskRowExpectation,
} from "./relay-task-flow.e2e";

describe("terminal file links", () => {
  const fixture = {
    path: "docs/mobile-file-preview.md",
    line: 4,
    missingLink: "docs/mobile-preview-missing.md",
    nonMarkdownLinks: [
      "apps/mobile/src/screens/TerminalWebView.tsx:42",
      "apps/mobile/package.json",
      "crates/daemon/src/lib.rs:9",
    ],
    rawLink: "docs/mobile-file-preview.md:4",
    renderedLink: "docs/mobile-file-preview.md",
  };

  it("waits for mixed terminal paths but exposes native controls only for Markdown", async () => {
    const controls = new Map([
      [`~Open file ${fixture.path}`, true],
      [`~Open file ${fixture.path} at line 4`, true],
      [`~Open file ${fixture.missingLink}`, true],
    ]);
    const driver = {
      $: vi.fn(async (selector: string) => ({
        isExisting: vi.fn(async () => controls.get(selector) ?? false),
        waitForDisplayed: vi.fn(async () => {
          if (!controls.get(selector)) throw new Error(`Missing control ${selector}`);
        }),
      })),
    };
    const ui = {
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        byteCount: 128,
        cols: 220,
        frameCount: 2,
        rows: 40,
        text: [
          fixture.renderedLink,
          fixture.rawLink,
          fixture.missingLink,
          ...fixture.nonMarkdownLinks,
        ].map((path) => `SCRIPT_INPUT: ${path}`).join("\n"),
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await verifyTerminalMarkdownFileControls(driver as never, ui as never, fixture);

    expect(driver.$).toHaveBeenCalledWith(`~Open file ${fixture.path}`);
    expect(driver.$).toHaveBeenCalledWith(`~Open file ${fixture.path} at line 4`);
    expect(driver.$).toHaveBeenCalledWith(`~Open file ${fixture.missingLink}`);
    for (const path of fixture.nonMarkdownLinks) {
      const [filePath, line] = path.match(/^(.*?):(\d+)$/)?.slice(1) ?? [path];
      expect(driver.$).toHaveBeenCalledWith(
        `~Open file ${filePath}${line ? ` at line ${line}` : ""}`,
      );
    }
  });

  it("fails when a Markdown native file-link control is missing", async () => {
    const driver = {
      $: vi.fn(async (selector: string) => ({
        isExisting: vi.fn(async () => false),
        waitForDisplayed: vi.fn(async () => {
          throw new Error(`Missing control ${selector}`);
        }),
      })),
    };
    const ui = {
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        text: [
          fixture.renderedLink,
          fixture.rawLink,
          fixture.missingLink,
          ...fixture.nonMarkdownLinks,
        ].join(" "),
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await expect(
      verifyTerminalMarkdownFileControls(driver as never, ui as never, fixture),
    ).rejects.toThrow(`Missing control ~Open file ${fixture.path}`);
  });

  it("fails when a non-Markdown native file-link control is exposed", async () => {
    const driver = {
      $: vi.fn(async (selector: string) => ({
        isExisting: vi.fn(async () => selector.includes("TerminalWebView.tsx")),
        waitForDisplayed: vi.fn(async () => undefined),
      })),
    };
    const ui = {
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        text: [
          fixture.renderedLink,
          fixture.rawLink,
          fixture.missingLink,
          ...fixture.nonMarkdownLinks,
        ].join(" "),
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await expect(
      verifyTerminalMarkdownFileControls(driver as never, ui as never, fixture),
    ).rejects.toThrow(/non-Markdown.*TerminalWebView\.tsx/i);
  });
});

describe("task file preview WebView inspection", () => {
  it("inspects each WebView until it finds the preview and restores native context", async () => {
    let context = "NATIVE_APP";
    const switchedContexts: string[] = [];
    const renderedInspection = {
      kind: "rendered",
      path: "docs/mobile-file-preview.md",
      tokenClass: "hljs-keyword",
      tokenColor: "rgb(255, 122, 178)",
      tokenHeight: 19,
      tokenText: "const",
      tokenWidth: 39,
      unhighlightedColor: "rgb(230, 237, 247)"
    };
    const driver = {
      execute: vi.fn(async () =>
        context === "WEBVIEW_preview" ? renderedInspection : null
      ),
      getContext: vi.fn(async () => context),
      getContexts: vi.fn(async () => [
        "NATIVE_APP",
        { id: "WEBVIEW_terminal" },
        { name: "WEBVIEW_preview" }
      ]),
      switchContext: vi.fn(async (nextContext: string) => {
        switchedContexts.push(nextContext);
        context = nextContext;
      })
    };

    await expect(
      inspectTaskFilePreviewWebView(driver as never)
    ).resolves.toEqual(renderedInspection);
    expect(switchedContexts).toEqual([
      "WEBVIEW_terminal",
      "WEBVIEW_preview",
      "NATIVE_APP"
    ]);
  });
});

describe("relay task action menu journey", () => {
  it("observes every task action, cancels, and leaves task detail visible", async () => {
    const calls: string[] = [];
    const displayedElement = (name: string) => ({
      waitForDisplayed: vi.fn(async () => {
        calls.push(`${name}.waitForDisplayed`);
      }),
    });
    const more = {
      ...displayedElement("more"),
      click: vi.fn(async () => {
        calls.push("more.click");
      }),
    };
    const title = displayedElement("title");
    const options = new Map([
      ["Advance Stage", displayedElement("Advance Stage")],
      ["Close Task", displayedElement("Close Task")],
      [
        "Cancel",
        {
          ...displayedElement("Cancel"),
          click: vi.fn(async () => {
            calls.push("Cancel.click");
          }),
        },
      ],
    ]);
    const ui = {
      getTaskActionMenuTitle: vi.fn(async () => title),
      getTaskActionOption: vi.fn(async (label: string) => {
        calls.push(`ui.getTaskActionOption:${label}`);
        return options.get(label);
      }),
      getTaskMoreButton: vi.fn(async () => more),
    };

    await verifyRelayTaskActionMenuJourney(ui as never);

    expect(calls).toEqual([
      "more.waitForDisplayed",
      "more.click",
      "title.waitForDisplayed",
      "ui.getTaskActionOption:Advance Stage",
      "Advance Stage.waitForDisplayed",
      "ui.getTaskActionOption:Close Task",
      "Close Task.waitForDisplayed",
      "ui.getTaskActionOption:Cancel",
      "Cancel.waitForDisplayed",
      "Cancel.click",
      "more.waitForDisplayed",
    ]);
  });
});

describe("relay quick reply journey", () => {
  it("long-presses Send, selects SGTM, and waits for the composer to clear", async () => {
    const calls: string[] = [];
    let composerValue = "";
    const input = {
      getAttribute: vi.fn(async (name: string) => {
        calls.push(`input.getAttribute:${name}`);
        return composerValue;
      }),
      setValue: vi.fn(async (value: string) => {
        calls.push(`input.setValue:${JSON.stringify(value)}`);
        composerValue = value;
      }),
      waitForDisplayed: vi.fn(async () => {
        calls.push("input.waitForDisplayed");
      }),
    };
    const send = {
      click: vi.fn(async () => {
        calls.push("send.click");
      }),
      longPress: vi.fn(async ({ duration }: { duration: number }) => {
        calls.push(`send.longPress:${duration}`);
      }),
      waitForDisplayed: vi.fn(async () => {
        calls.push("send.waitForDisplayed");
      }),
    };
    const title = {
      waitForDisplayed: vi.fn(async () => {
        calls.push("title.waitForDisplayed");
      }),
    };
    const quickReply = {
      click: vi.fn(async () => {
        calls.push("quickReply.click");
        composerValue = "Reply…";
      }),
      waitForDisplayed: vi.fn(async () => {
        calls.push("quickReply.waitForDisplayed");
      }),
    };
    const ui = {
      getQuickRepliesMenuTitle: vi.fn(async () => title),
      getQuickReplyOption: vi.fn(async (label: string) => {
        calls.push(`ui.getQuickReplyOption:${label}`);
        return quickReply;
      }),
      getTaskInput: vi.fn(async () => input),
      getTaskSendButton: vi.fn(async () => send),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };
    await verifyRelayQuickReplyJourney(
      ui as never,
      "  Preserve the relay fixture.  ",
    );

    expect(send.click).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "input.waitForDisplayed",
      'input.setValue:"  Preserve the relay fixture.  "',
      "send.waitForDisplayed",
      "send.longPress:800",
      "title.waitForDisplayed",
      "ui.getQuickReplyOption:SGTM. Proceed.",
      "quickReply.waitForDisplayed",
      "quickReply.click",
      "input.getAttribute:value",
    ]);
  });
});

describe("relay quick reply transport observation", () => {
  const expectedInput = "SGTM. Proceed.\n\nPreserve the relay fixture.";

  function assertSingleTaskInput(output: string): void {
    assertSingleSubmittedTaskInput(output, expectedInput);
  }

  it("accepts one exact multiline task input after normalizing PTY newlines", () => {
    expect(() =>
      assertSingleTaskInput(
        "SCRIPT_READY\r\nSCRIPT_INPUT:SGTM. Proceed.\r\n\r\n" +
          "Preserve the relay fixture.\r\nSCRIPT_HEARTBEAT 1\r\n",
      )
    ).not.toThrow();
  });

  it("rejects a duplicate normal send before the quick reply", () => {
    expect(() =>
      assertSingleTaskInput(
        "SCRIPT_INPUT:Preserve the relay fixture.\r\n" +
          "SCRIPT_INPUT:SGTM. Proceed.\r\n\r\nPreserve the relay fixture.\r\n",
      )
    ).toThrow(/exactly one task input.*observed 2/i);
  });
});

const taskRowExpectation: RelayTaskRowExpectation = {
  title: "Relay card current title",
  stage: "in progress",
  waitingPromptSnippet: "Relay card current title",
  originalPromptSnippet: "Original relay request must stay hidden",
  repoLabel: "Relay fixture repository",
};

function expectedTaskRowLabel(): string {
  return `${taskRowExpectation.title}. ${taskRowExpectation.stage}`;
}

function createTaskRow(label: string, calls: string[] = []) {
  return {
    click: vi.fn(async () => {
      calls.push("click");
    }),
    getAttribute: vi.fn(async (name: string) => {
      calls.push(`getAttribute:${name}`);
      return label;
    }),
    getText: vi.fn(async () => label),
    waitForDisplayed: vi.fn(async () => {
      calls.push("waitForDisplayed");
    }),
  };
}

describe("verifyRelayTaskActivityTransitions", () => {
  it("observes working, unread, and idle through the rendered row value", async () => {
    let activity = "working";
    const observed: string[] = [];
    const row = {
      getAttribute: vi.fn(async (name: string) => {
        expect(name).toBe("value");
        observed.push(activity);
        return activity;
      }),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      getTaskRows: vi.fn(async () => []),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await condition()) return;
        }
        throw new Error(options.timeoutMsg);
      }),
    };
    const setTaskActivity = vi.fn(async (next: "unread" | "idle") => {
      activity = next;
    });

    await verifyRelayTaskActivityTransitions(
      ui as never,
      "cloud-task-1",
      setTaskActivity,
    );

    expect(observed).toEqual(["working", "unread", "idle"]);
    expect(setTaskActivity.mock.calls).toEqual([["unread"], ["idle"]]);
  });

  it("opens an unread task and waits for the real owner action before asserting idle", async () => {
    let activity = "working";
    let taskOpen = false;
    let ownerIdle = false;
    const row = {
      getAttribute: vi.fn(async () => activity),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };
    const actions = {
      prepareUnread: vi.fn(async () => {
        activity = "unread";
      }),
      openTask: vi.fn(async () => {
        taskOpen = true;
      }),
      waitForOwnerIdle: vi.fn(async () => {
        expect(taskOpen).toBe(true);
        ownerIdle = true;
      }),
      waitForSelectedDetailIdle: vi.fn(async () => {
        expect(ownerIdle).toBe(true);
        activity = "idle";
      }),
      closeTask: vi.fn(async () => {
        taskOpen = false;
      }),
    };

    await verifyRelayTaskMarkedRead(ui as never, "cloud-task-1", actions);

    expect(actions.prepareUnread).toHaveBeenCalledTimes(1);
    expect(actions.openTask).toHaveBeenCalledTimes(1);
    expect(actions.waitForOwnerIdle).toHaveBeenCalledTimes(1);
    expect(actions.waitForSelectedDetailIdle).toHaveBeenCalledTimes(1);
    expect(actions.closeTask).toHaveBeenCalledTimes(1);
    expect(activity).toBe("idle");
  });

  it("reports the last native activity value when a transition times out", async () => {
    const row = { getAttribute: vi.fn(async () => "unread") };
    const otherRow = {
      getAttribute: vi.fn(async (name: string) =>
        name === "name" ? "mobile.task-row.cloud-task-2" : null
      ),
    };
    const ui = {
      getTaskRowById: vi.fn(async () => row),
      getTaskRows: vi.fn(async () => [otherRow]),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>) => {
        await condition();
        throw new Error("timeout");
      }),
    };

    await expect(
      verifyRelayTaskActivityTransitions(ui as never, "cloud-task-1", vi.fn()),
    ).rejects.toThrow(
      'last native accessibility value was unread; rendered task row ids were ["cloud-task-2"]',
    );
  });
});

describe("relay task row presentation", () => {
  it("inspects the exact row before opening it", async () => {
    const calls: string[] = [];
    const row = createTaskRow(expectedTaskRowLabel(), calls);
    const ui = { getTaskRowById: vi.fn(async () => row) };

    await openRelayFixtureTask(
      ui,
      "cloud:desktop:repo:task",
      taskRowExpectation,
    );

    expect(ui.getTaskRowById).toHaveBeenCalledWith("cloud:desktop:repo:task");
    expect(calls).toEqual(["waitForDisplayed", "getAttribute:label", "click"]);
  });

  it("accepts a duplicated waiting preview rendered only once", async () => {
    await expect(
      assertRelayTaskRowPresentation(
        createTaskRow(expectedTaskRowLabel()),
        taskRowExpectation,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a duplicated waiting preview rendered twice", async () => {
    const duplicatedLabel =
      `${expectedTaskRowLabel()}. ${taskRowExpectation.waitingPromptSnippet}`;

    await expect(
      assertRelayTaskRowPresentation(
        createTaskRow(duplicatedLabel),
        taskRowExpectation,
      ),
    ).rejects.toThrow("unexpected content");
  });

  it.each([
    ["original prompt", taskRowExpectation.originalPromptSnippet],
    ["repository label", taskRowExpectation.repoLabel],
    ["TASK marker", "TASK"],
    ["RECENT marker", "RECENT"],
  ])("rejects a row containing the %s", async (_label, forbidden) => {
    const row = createTaskRow(`${expectedTaskRowLabel()}. ${forbidden}`);

    await expect(
      assertRelayTaskRowPresentation(row, taskRowExpectation),
    ).rejects.toThrow("unexpected content");
    expect(row.click).not.toHaveBeenCalled();
  });
});
