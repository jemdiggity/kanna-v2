import { describe, expect, it, vi } from "vitest";
import { assertSingleSubmittedTaskInput } from "../../helpers/relay-harness";
import {
  assertRecentTaskRowShowsRepoLabel,
  assertRelayTaskRowPresentation,
  inspectTaskFilePreviewWebView,
  openMentionedFileMenuSelection,
  openRelayFixtureTask,
  performFirstQuickReplyDrag,
  relaunchRelayAppPreservingData,
  verifyRelayCustomizedQuickReplyJourney,
  verifyRelayComposerResetJourney,
  verifyRelayQuickReplyPersistenceJourney,
  verifyRelayTaskActionMenuJourney,
  verifyRelayQuickReplyJourney,
  verifyRelayVisualCompanionJourney,
  verifyRelayTaskActivityTransitions,
  verifyRelayTaskMarkedRead,
  verifyRecentTabShowsRepoLabel,
  type RelayTaskRowExpectation,
} from "./relay-task-flow.e2e";
import * as relayTaskFlow from "./relay-task-flow.e2e";

describe("relay task flow orchestration", () => {
  it("marks the task read from the list before revisiting its terminal and continuing on detail", async () => {
    const calls: string[] = [];
    let screen: "detail" | "list" = "list";
    const runRelayTaskJourneys = (
      relayTaskFlow as typeof relayTaskFlow & {
        runRelayTaskJourneys?: (journeys: {
          verifyComposerReset(): Promise<void>;
          verifyFilePreview(): Promise<void>;
          verifyMarkedRead(): Promise<void>;
          verifyPtySnapshotRevisit(): Promise<void>;
          verifyQuickReply(): Promise<void>;
          verifyQuickReplyPersistence(): Promise<void>;
          verifyTaskActionMenu(): Promise<void>;
          verifyVisualCompanion(): Promise<void>;
        }) => Promise<void>;
      }
    ).runRelayTaskJourneys;

    expect(runRelayTaskJourneys).toBeTypeOf("function");
    if (!runRelayTaskJourneys) return;

    await runRelayTaskJourneys({
      async verifyQuickReplyPersistence() {
        expect(screen).toBe("list");
        calls.push("quick-reply-persistence");
      },
      async verifyMarkedRead() {
        expect(screen).toBe("list");
        calls.push("marked-read");
      },
      async verifyPtySnapshotRevisit() {
        expect(screen).toBe("list");
        screen = "detail";
        calls.push("open", "rendered");
        screen = "list";
        calls.push("close");
        screen = "detail";
        calls.push("open", "rendered");
      },
      async verifyTaskActionMenu() {
        expect(screen).toBe("detail");
        calls.push("task-actions");
      },
      async verifyVisualCompanion() {
        expect(screen).toBe("detail");
        calls.push("visual-companion");
      },
      async verifyFilePreview() {
        expect(screen).toBe("detail");
        calls.push("file-preview");
      },
      async verifyComposerReset() {
        expect(screen).toBe("detail");
        calls.push("composer-reset");
      },
      async verifyQuickReply() {
        expect(screen).toBe("detail");
        calls.push("quick-reply", "transport");
      },
    });

    expect(calls).toEqual([
      "quick-reply-persistence",
      "marked-read",
      "open",
      "rendered",
      "close",
      "open",
      "rendered",
      "quick-reply",
      "transport",
      "task-actions",
      "file-preview",
      "visual-companion",
      "composer-reset",
    ]);
    expect(screen).toBe("detail");
  });
});

describe("customized quick reply relay journey", () => {
  it("waits for the task-input transport immediately after the drag sends", async () => {
    const calls: string[] = [];

    await verifyRelayCustomizedQuickReplyJourney(
      {
        dragFirstQuickReply: vi.fn(async () => {
          calls.push("drag-send");
        }),
        getTaskInput: vi.fn(async () => ({
          addValue: vi.fn(async () => undefined),
          getAttribute: vi.fn(async () => ""),
          setValue: vi.fn(async () => undefined),
          waitForDisplayed: vi.fn(async () => undefined),
        })),
        getTaskSendButton: vi.fn(async () => ({
          click: vi.fn(async () => undefined),
          getAttribute: vi.fn(async () => null),
          waitForDisplayed: vi.fn(async () => undefined),
        })),
        isKeyboardShown: vi.fn(async () => false),
        pause: vi.fn(async () => undefined),
        waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
          if (await condition()) return;
          throw new Error(options.timeoutMsg);
        }),
      },
      "Preserve the relay fixture.",
      async () => {
        calls.push("transport");
      },
    );

    expect(calls).toEqual(["drag-send", "transport"]);
  });
});

describe("oversized PTY snapshot revisit", () => {
  it("renders the authoritative snapshot before and after reopening the task", async () => {
    const calls: string[] = [];
    const verifyRelayPtySnapshotRevisit = (
      relayTaskFlow as typeof relayTaskFlow & {
        verifyRelayPtySnapshotRevisit?: (journey: {
          closeTask(): Promise<void>;
          openTask(): Promise<void>;
          waitForRenderedTerminal(): Promise<void>;
        }) => Promise<void>;
      }
    ).verifyRelayPtySnapshotRevisit;

    expect(verifyRelayPtySnapshotRevisit).toBeTypeOf("function");
    if (!verifyRelayPtySnapshotRevisit) return;

    await verifyRelayPtySnapshotRevisit({
      async openTask() {
        calls.push("open");
      },
      async waitForRenderedTerminal() {
        calls.push("rendered");
      },
      async closeTask() {
        calls.push("close");
      },
    });

    expect(calls).toEqual([
      "open",
      "rendered",
      "close",
      "open",
      "rendered",
    ]);
  });
});

describe("Tasks-tab creation ordering journey", () => {
  it("selects Tasks and accepts native task rows only in newest-first order", async () => {
    const verifyTasksTabNewestFirst = (
      await import("./relay-task-flow.e2e")
    ) as typeof import("./relay-task-flow.e2e") & {
      verifyTasksTabNewestFirst?: (
        ui: Record<string, unknown>,
        fixture: {
          sourceOrderTaskIds: string[];
          expectedVisualOrderTaskIds: string[];
        },
      ) => Promise<void>;
    };
    expect(verifyTasksTabNewestFirst.verifyTasksTabNewestFirst).toBeTypeOf(
      "function",
    );
    if (!verifyTasksTabNewestFirst.verifyTasksTabNewestFirst) return;

    const tasksTab = { click: vi.fn(async () => undefined) };
    const taskRows = ["task-newer", "task-older"].map((taskId) => ({
      getAttribute: vi.fn(async (name: string) =>
        name === "name" ? `mobile.task-row.${taskId}` : null
      ),
    }));
    const ui = {
      getTasksTab: vi.fn(async () => tasksTab),
      getTaskRows: vi.fn(async () => taskRows),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await verifyTasksTabNewestFirst.verifyTasksTabNewestFirst(ui, {
      sourceOrderTaskIds: ["task-older", "task-newer"],
      expectedVisualOrderTaskIds: ["task-newer", "task-older"],
    });

    expect(tasksTab.click).toHaveBeenCalledTimes(1);
    expect(ui.getTaskRows).toHaveBeenCalled();
  });

  it("reports the reversed source order when native rows are not newest first", async () => {
    const tasksTab = { click: vi.fn(async () => undefined) };
    const taskRows = ["task-older", "task-newer"].map((taskId) => ({
      getAttribute: vi.fn(async (name: string) =>
        name === "name" ? `mobile.task-row.${taskId}` : null
      ),
    }));
    const ui = {
      getTasksTab: vi.fn(async () => tasksTab),
      getTaskRows: vi.fn(async () => taskRows),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    const { verifyTasksTabNewestFirst } = await import(
      "./relay-task-flow.e2e"
    );
    await expect(
      verifyTasksTabNewestFirst(ui as never, {
        sourceOrderTaskIds: ["task-older", "task-newer"],
        expectedVisualOrderTaskIds: ["task-newer", "task-older"],
      }),
    ).rejects.toThrow(
      'source order was ["task-older","task-newer"]; native visual order was ["task-older","task-newer"]',
    );
  });
});

describe("relay visual companion journey", () => {
  it("blocks offline selection until a fresh snapshot and explicit retry", async () => {
    const calls: string[] = [];
    let text = "Initial relay visual companion";
    const ui = {
      open: vi.fn(async () => {
        calls.push("open");
      }),
      close: vi.fn(async () => {
        calls.push("close");
      }),
      clickChoice: vi.fn(async (choice: string) => {
        calls.push(`click:${choice}`);
      }),
      tryClickChoice: vi.fn(async () => {
        calls.push("offline-click-blocked");
        return false;
      }),
      readDocumentText: vi.fn(async () => text),
      waitForEnded: vi.fn(async () => {
        calls.push("ended");
      }),
      waitForNoInteractiveWebView: vi.fn(async () => {
        calls.push("no-webview");
      }),
      waitForReconnecting: vi.fn(async () => {
        calls.push("reconnecting");
      }),
      waitForSourceError: vi.fn(async () => {
        calls.push("source-error");
      }),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      })
    };
    const actions = {
      disconnect: vi.fn(async () => {
        calls.push("disconnect");
      }),
      expectNoEvent: vi.fn(async (choice: string) => {
        calls.push(`no-event:${choice}`);
      }),
      invalidateSource: vi.fn(async () => {
        calls.push("invalidate");
      }),
      reconnect: vi.fn(async () => {
        calls.push("reconnect");
      }),
      resume: vi.fn(async () => {
        calls.push("resume");
      }),
      restoreSource: vi.fn(async () => {
        calls.push("restore");
        text = "Updated relay visual companion";
      }),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      waitForEvent: vi.fn(async (choice: string) => {
        calls.push(`event:${choice}`);
      })
    };

    await verifyRelayVisualCompanionJourney(
      ui,
      {
        choice: "relay-layout-a",
        initialMarker: "Initial relay visual companion",
        sessionId: "mobile-relay-companion",
        sourceErrorMessage:
          "The visual companion is too large. Ask the agent to simplify the screen.",
        updatedMarker: "Updated relay visual companion"
      },
      actions
    );

    expect(calls).toEqual([
      "open",
      "invalidate",
      "source-error",
      "no-webview",
      "offline-click-blocked",
      "no-event:relay-layout-a",
      "restore",
      "disconnect",
      "reconnecting",
      "offline-click-blocked",
      "no-event:relay-layout-a",
      "reconnect",
      "no-event:relay-layout-a",
      "click:relay-layout-a",
      "event:relay-layout-a",
      "stop",
      "ended",
      "resume",
      "close"
    ]);
  });
});

describe("mentioned file menu", () => {
  const fixture = {
    ambiguousBarePath: "shared.ts",
    ambiguousCanonicalPaths: [
      "fixtures/a/shared.ts",
      "fixtures/b/shared.ts"
    ],
    expectedCanonicalRowOrder: [
      "fixtures/unique/TaskScreen.tsx",
      "fixtures/a/shared.ts",
      "fixtures/b/shared.ts",
      "docs/spec.md"
    ],
    mentionedCount: 3,
    mentionedLinks: [
      "docs/spec.md",
      "TaskScreen.tsx:7",
      "shared.ts",
      "TaskScreen.tsx:7"
    ],
    path: "docs/spec.md",
    line: 7,
    missingLink: "docs/mobile-preview-missing.md",
    rawLink: "TaskScreen.tsx:7",
    renderedLink: "docs/spec.md",
    uniqueBarePath: "TaskScreen.tsx",
    uniqueCanonicalPath: "fixtures/unique/TaskScreen.tsx"
  };

  it("opens the dynamic menu, exposes canonical rows, and selects the unique file", async () => {
    const clicked: string[] = [];
    const measuredRows: string[] = [];
    const driver = {
      $: vi.fn(async (selector: string) => {
        const exists = selector !== "~Files mentioned in terminal";
        const rowIndex = fixture.expectedCanonicalRowOrder.findIndex(
          (path) => selector === `~mobile.task-mentioned-files.row.${path}`
        );
        return {
          click: vi.fn(async () => {
            clicked.push(selector);
          }),
          getAttribute: vi.fn(async (attribute: string) =>
            attribute === "label" &&
            selector.includes('label BEGINSWITH "Mentioned Files ("')
              ? "Mentioned Files (3)"
              : null
          ),
          getLocation: vi.fn(async (axis: string) => {
            if (axis !== "y" || rowIndex < 0) {
              throw new Error(`Unexpected location request ${axis} for ${selector}`);
            }
            measuredRows.push(selector);
            return 200 + rowIndex * 48;
          }),
          isExisting: vi.fn(async () => exists),
          waitForDisplayed: vi.fn(async () => {
            if (!exists) throw new Error(`Missing control ${selector}`);
          })
        };
      }),
      pause: vi.fn(async () => undefined)
    };
    const ui = {
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        byteCount: 128,
        cols: 220,
        frameCount: 2,
        rows: 40,
        text: fixture.mentionedLinks
          .map((path) => `SCRIPT_INPUT: ${path}`)
          .join("\n")
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await openMentionedFileMenuSelection(
      driver as never,
      ui as never,
      fixture
    );

    expect(clicked).toEqual([
      "~mobile.task-more-button",
      '-ios predicate string:label BEGINSWITH "Mentioned Files ("',
      "~mobile.task-mentioned-files.row.fixtures/unique/TaskScreen.tsx"
    ]);
    expect(measuredRows).toEqual(
      fixture.expectedCanonicalRowOrder.map(
        (path) => `~mobile.task-mentioned-files.row.${path}`
      )
    );
    for (const path of [
      fixture.uniqueCanonicalPath,
      ...fixture.ambiguousCanonicalPaths,
      fixture.path
    ]) {
      expect(driver.$).toHaveBeenCalledWith(
        `~mobile.task-mentioned-files.row.${path}`
      );
    }
    expect(driver.$).toHaveBeenCalledWith("~Files mentioned in terminal");
  });

  it("fails when all expected mentions have not reached the terminal bridge", async () => {
    const driver = {
      $: vi.fn(async (selector: string) => ({
        click: vi.fn(async () => undefined),
        isExisting: vi.fn(async () => true),
        waitForDisplayed: vi.fn(async () => undefined)
      })),
      pause: vi.fn(async () => undefined)
    };
    const ui = {
      inspectTerminalWebView: vi.fn(async () => ({
        kind: "rendered" as const,
        text: fixture.mentionedLinks.slice(0, 2).join(" ")
      })),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await expect(
      openMentionedFileMenuSelection(driver as never, ui as never, fixture),
    ).rejects.toThrow(/expected mentioned file paths/i);
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
      ["Mentioned Files (0)", displayedElement("Mentioned Files (0)")],
      ["View Diff", displayedElement("View Diff")],
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
      "ui.getTaskActionOption:Mentioned Files (0)",
      "Mentioned Files (0).waitForDisplayed",
      "ui.getTaskActionOption:View Diff",
      "View Diff.waitForDisplayed",
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

describe("relay composer reset journey", () => {
  const multilineDraft =
    "First relay line.\nSecond relay line.\nThird relay line.";

  function createComposerResetUi({
    dismissKeyboard = true,
    resetHeight = true,
  }: {
    dismissKeyboard?: boolean;
    resetHeight?: boolean;
  } = {}) {
    let composerHeight = 40;
    let composerValue: string | null = "";
    let keyboardShown = false;
    const input = {
      click: vi.fn(async () => {
        keyboardShown = true;
      }),
      getAttribute: vi.fn(async (name: string) => {
        if (name === "value") return composerValue;
        return name === "label" && composerValue === null ? "Reply…" : null;
      }),
      getSize: vi.fn(async () => ({ height: composerHeight, width: 240 })),
      setValue: vi.fn(async (value: string) => {
        composerValue = value;
        composerHeight = 82;
      }),
      waitForDisplayed: vi.fn(async () => undefined),
    };
    const send = {
      click: vi.fn(async () => {
        composerValue = "";
        if (resetHeight) composerHeight = 40;
        if (dismissKeyboard) keyboardShown = false;
      }),
      waitForDisplayed: vi.fn(async () => undefined),
    };
    const ui = {
      getTaskInput: vi.fn(async () => input),
      getTaskSendButton: vi.fn(async () => send),
      isKeyboardShown: vi.fn(async () => keyboardShown),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    return { input, send, ui };
  }

  it("observes multiline native growth, then Send resets height and hides the keyboard", async () => {
    const { input, send, ui } = createComposerResetUi();

    await verifyRelayComposerResetJourney(ui as never);

    expect(input.click).toHaveBeenCalledOnce();
    expect(input.setValue).toHaveBeenCalledWith(multilineDraft);
    expect(input.getSize).toHaveBeenCalled();
    expect(send.click).toHaveBeenCalledOnce();
    expect(ui.isKeyboardShown).toHaveBeenCalled();
  });

  it("fails when Send leaves the cleared native input expanded", async () => {
    const { ui } = createComposerResetUi({ resetHeight: false });

    await expect(
      verifyRelayComposerResetJourney(ui as never),
    ).rejects.toThrow(/clear, return to one-line height, and hide the keyboard/i);
  });

  it("fails when Send leaves the software keyboard shown", async () => {
    const { ui } = createComposerResetUi({ dismissKeyboard: false });

    await expect(
      verifyRelayComposerResetJourney(ui as never),
    ).rejects.toThrow(/clear, return to one-line height, and hide the keyboard/i);
  });
});

describe("relay quick reply journey", () => {
  it("edits, saves, relaunches, and reloads the first ordered quick reply", async () => {
    const calls: string[] = [];
    let draft = "SGTM. Proceed.";
    let persisted = draft;
    let relaunched = false;
    const input = {
      getAttribute: vi.fn(async (name: string) => {
        calls.push(`input.getAttribute:${name}`);
        return name === "value" ? (relaunched ? persisted : draft) : null;
      }),
      setValue: vi.fn(async (value: string) => {
        calls.push(`input.setValue:${value}`);
        draft = value;
      }),
    };
    const journey = {
      closeEditor: vi.fn(async () => {
        calls.push("close-editor");
      }),
      getFirstReplyInput: vi.fn(async () => input),
      openEditor: vi.fn(async () => {
        calls.push("open-editor");
      }),
      relaunchPreservingData: vi.fn(async () => {
        calls.push("relaunch");
        relaunched = true;
      }),
      save: vi.fn(async () => {
        calls.push("save");
        persisted = draft;
      }),
      waitForEditorClosed: vi.fn(async () => {
        calls.push("editor-closed");
      }),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await verifyRelayQuickReplyPersistenceJourney(
      journey as never,
      "Persisted relay approval.",
    );

    expect(calls).toEqual([
      "open-editor",
      "input.setValue:Persisted relay approval.",
      "save",
      "editor-closed",
      "relaunch",
      "open-editor",
      "input.getAttribute:value",
      "close-editor",
    ]);
  });

  it("waits for a complete process stop before reactivating the app", async () => {
    const driver = {
      activateApp: vi.fn(async () => undefined),
      queryAppState: vi.fn(async () => 4),
      terminateApp: vi.fn(async () => true),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) return;
        throw new Error(options.timeoutMsg);
      }),
    };

    await expect(
      relaunchRelayAppPreservingData(driver as never, "build.kanna.app.dev"),
    ).rejects.toThrow(/terminate before relaunch/i);
    expect(driver.terminateApp).toHaveBeenCalledWith(
      undefined,
      "build.kanna.app.dev",
    );
    expect(driver.activateApp).not.toHaveBeenCalled();
  });

  it("performs the native iOS long-press drag coordinates", async () => {
    const send = {
      getLocation: vi.fn(async () => ({ x: 100, y: 200 })),
      getSize: vi.fn(async () => ({ width: 58, height: 40 }))
    };
    const driver = {
      $: vi.fn(async () => send),
      execute: vi.fn(async () => undefined),
    };

    await performFirstQuickReplyDrag(driver as never);

    expect(driver.execute).toHaveBeenCalledWith(
      "mobile: dragFromToForDuration",
      {
        duration: 0.65,
        fromX: 129,
        fromY: 220,
        toX: 129,
        toY: 168,
      },
    );
  });

  it("propagates a native quick-reply drag failure", async () => {
    const driver = {
      $: vi.fn(async () => ({
        getLocation: vi.fn(async () => ({ x: 0, y: 0 })),
        getSize: vi.fn(async () => ({ width: 58, height: 40 }))
      })),
      execute: vi.fn(async () => {
        throw new Error("gesture failed");
      }),
    };

    await expect(performFirstQuickReplyDrag(driver as never)).rejects.toThrow(
      "gesture failed"
    );
  });

  it("drags from Send to SGTM and waits for the composer to clear", async () => {
    const calls: string[] = [];
    let composerValue: string | null = "";
    const input = {
      getAttribute: vi.fn(async (name: string) => {
        calls.push(`input.getAttribute:${name}`);
        if (name === "value") {
          return composerValue;
        }
        return name === "label" && composerValue === null ? "Reply…" : null;
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
      waitForDisplayed: vi.fn(async () => {
        calls.push("send.waitForDisplayed");
      }),
    };
    const ui = {
      dragFirstQuickReply: vi.fn(async () => {
        calls.push("ui.dragFirstQuickReply");
        composerValue = null;
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

    expect(calls).toEqual([
      "input.waitForDisplayed",
      'input.setValue:"  Preserve the relay fixture.  "',
      "send.waitForDisplayed",
      "ui.dragFirstQuickReply",
      "input.getAttribute:value",
      "input.getAttribute:label",
    ]);
  });
});

describe("relay quick reply transport observation", () => {
  const expectedInput =
    "Persisted relay approval.\n\nPreserve the relay fixture.";

  function assertSingleTaskInput(output: string): void {
    assertSingleSubmittedTaskInput(output, expectedInput);
  }

  it("accepts one exact multiline task input after normalizing PTY newlines", () => {
    expect(() =>
      assertSingleTaskInput(
        "SCRIPT_READY\r\nSCRIPT_INPUT:Persisted relay approval.\r\n\r\n" +
          "Preserve the relay fixture.\r\nSCRIPT_HEARTBEAT 1\r\n",
      )
    ).not.toThrow();
  });

  it("ignores unrelated scripted inputs when counting the exact quick reply", () => {
    expect(() =>
      assertSingleTaskInput(
        "SCRIPT_INPUT: docs/mobile-file-preview.md\r\n" +
          "SCRIPT_INPUT: docs/mobile-file-preview.md:4\r\n" +
          "SCRIPT_INPUT: docs/mobile-preview-missing.md\r\n" +
          "SCRIPT_INPUT:Persisted relay approval.\r\r\n\r\r\n" +
          "Preserve the relay fixture.\r\r\n",
      )
    ).not.toThrow();
  });

  it("rejects the exact quick reply when it is submitted twice", () => {
    expect(() =>
      assertSingleTaskInput(
        "SCRIPT_INPUT:Persisted relay approval.\r\n\r\nPreserve the relay fixture.\r\n" +
          "SCRIPT_INPUT:Persisted relay approval.\r\n\r\nPreserve the relay fixture.\r\n",
      )
    ).toThrow(/exactly one matching task input.*observed 2/i);
  });
});

const taskRowExpectation: RelayTaskRowExpectation = {
  title: "Relay card current title",
  stage: "in progress",
  taskId: "task-local",
  waitingPromptSnippet: "Relay card current title",
  originalPromptSnippet: "Original relay request must stay hidden",
  repoLabel: "Relay fixture repository",
};

function expectedTaskRowLabel(): string {
  return `${taskRowExpectation.title}. Task ID ${taskRowExpectation.taskId}. ` +
    `${taskRowExpectation.stage}`;
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
    scrollIntoView: vi.fn(async () => {
      calls.push("scrollIntoView");
    }),
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
    expect(calls).toEqual([
      "scrollIntoView",
      "waitForDisplayed",
      "getAttribute:label",
      "click",
    ]);
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

describe("recent task row repo label", () => {
  const expectedRecentRowLabel = () =>
    `${taskRowExpectation.title}. Task ID ${taskRowExpectation.taskId}. ` +
    `${taskRowExpectation.repoLabel}. ` +
    `${taskRowExpectation.stage}`;

  it("accepts a recent row that announces the repo after the title", async () => {
    await expect(
      assertRecentTaskRowShowsRepoLabel(
        createTaskRow(expectedRecentRowLabel()),
        taskRowExpectation,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a recent row that omits the repo label", async () => {
    await expect(
      assertRecentTaskRowShowsRepoLabel(
        createTaskRow(expectedTaskRowLabel()),
        taskRowExpectation,
      ),
    ).rejects.toThrow("unexpected content");
  });

  it("checks the fixture row on the Recent tab and returns to the Tasks tab", async () => {
    const calls: string[] = [];
    const row = createTaskRow(expectedRecentRowLabel(), calls);
    const recentTab = {
      click: vi.fn(async () => {
        calls.push("recentTab.click");
      }),
    };
    const tasksTab = {
      click: vi.fn(async () => {
        calls.push("tasksTab.click");
      }),
    };
    const ui = {
      getRecentTab: vi.fn(async () => recentTab),
      getTasksTab: vi.fn(async () => tasksTab),
      getTaskRowById: vi.fn(async () => row),
    };

    await verifyRecentTabShowsRepoLabel(
      ui as never,
      "cloud:desktop:repo:task",
      taskRowExpectation,
    );

    expect(ui.getTaskRowById).toHaveBeenCalledWith("cloud:desktop:repo:task");
    expect(calls).toEqual([
      "recentTab.click",
      "scrollIntoView",
      "waitForDisplayed",
      "getAttribute:label",
      "tasksTab.click",
    ]);
  });
});
