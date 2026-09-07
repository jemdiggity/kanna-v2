// Photo attachments cross every boundary the feature has: the phone's
// transport (LAN and relay both), the server's HTTP surface, the filesystem
// the agent reads from, and the PTY the message is injected into. Nothing
// below the transport is mocked here — the file assertions read the real
// desktop's real attachment directory, and the message assertions read what
// the real agent process printed after receiving it.
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLanTransport,
  type FetchLike,
  type WebSocketLike
} from "../../../apps/mobile/src/lib/transports/lanTransport";
import type { TaskInputAttachment } from "../../../apps/mobile/src/lib/api/types";
import { startRemoteHarness, type RemoteHarness } from "./harness";
import { localProcessFetch } from "./localProcessFetch";
import {
  collectTerminalEvents,
  createScriptedTask,
  waitForCondition,
  type TerminalEventCollector
} from "./terminalFlowTestUtils";

// A one-pixel PNG: small enough to assert byte-for-byte, and a real image
// header so nothing downstream has to pretend it is one.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function pngAttachment(fileName: string): TaskInputAttachment {
  return {
    fileName,
    mediaType: "image/png",
    dataBase64: PNG_BYTES.toString("base64")
  };
}

/**
 * Where the desktop stores a task's attachments, derived exactly as the server
 * derives it — from the database this instance owns.
 */
function taskAttachmentsDir(harness: RemoteHarness, taskId: string): string {
  const dbPath = harness.paths.dbPath;
  const stem = basename(dbPath).replace(/\.[^.]+$/, "");
  return join(dirname(dbPath), `${stem}-task-attachments`, taskId);
}

async function storedAttachments(
  harness: RemoteHarness,
  taskId: string
): Promise<string[]> {
  const directory = taskAttachmentsDir(harness, taskId);
  try {
    const names = await readdir(directory);
    return names.sort().map((name) => join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const nodeFetch: FetchLike = async (input, init) =>
  localProcessFetch(input, init);

function createLanClient(harness: RemoteHarness) {
  return createLanTransport(
    harness.lanBaseUrl,
    nodeFetch,
    // The attachment paths never open a socket; the terminal stream is
    // observed through the harness relay client instead.
    () => {
      throw new Error("the attachment spec does not open LAN sockets");
    }
  );
}

interface AttachedTask {
  taskId: string;
  events: TerminalEventCollector;
}

async function startAttachableTask(
  harness: RemoteHarness,
  displayName: string
): Promise<AttachedTask> {
  const task = await createScriptedTask(harness, { displayName });
  const events = collectTerminalEvents(harness, task.taskId);
  await events.waitForOutput("SCRIPT_READY", 30_000);
  return { taskId: task.taskId, events };
}

/**
 * Assert the whole chain for one delivery: exactly one new file with the right
 * bytes, an injected message naming that file's absolute path on one
 * submission, and a durable record carrying the same text.
 */
async function expectAttachmentReachedTheAgent(
  harness: RemoteHarness,
  task: AttachedTask,
  text: string,
  namePrefix: string
): Promise<string> {
  await waitForCondition(
    async () => (await storedAttachments(harness, task.taskId)).length > 0,
    10_000,
    `no attachment was stored for ${task.taskId}`
  );
  const stored = await storedAttachments(harness, task.taskId);
  expect(stored).toHaveLength(1);
  expect(basename(stored[0])).toMatch(
    new RegExp(`^${namePrefix}-.+\\.png$`)
  );
  expect(await readFile(stored[0])).toEqual(PNG_BYTES);

  const expectedMessage = `${text} [Attached image: ${stored[0]}]`;
  const output = await task.events.waitForOutput(
    `SCRIPT_INPUT:${expectedMessage}`,
    20_000
  );
  // One `SCRIPT_INPUT:` line, not two: the reference must ride the same
  // submission as the text, or the agent sees the words before the picture.
  expect(output.split(`SCRIPT_INPUT:${expectedMessage}`)).toHaveLength(2);

  const inputs = (await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "GET",
    path: `/v1/tasks/${task.taskId}/inputs`,
    body: null
  })) as { inputs: Array<{ message: string }> };
  expect(inputs.inputs.at(-1)?.message).toBe(expectedMessage);

  return stored[0];
}

describe("Task photo attachment E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("lands a LAN-uploaded photo on disk and names it in the injected input", async () => {
    const task = await startAttachableTask(harness, "LAN photo attachment");
    const transport = createLanClient(harness);

    try {
      await transport.sendTaskInput(
        task.taskId,
        "look at this",
        pngAttachment("lan-shot.png")
      );

      await expectAttachmentReachedTheAgent(
        harness,
        task,
        "look at this",
        "lan-shot"
      );
    } finally {
      task.events.close();
    }
  }, 90_000);

  it("carries the same photo over the relay to the owning desktop", async () => {
    const task = await startAttachableTask(harness, "Relay photo attachment");

    try {
      // The relay path is a JSON desktop invocation, which is exactly why the
      // wire format is base64-in-body on both transports rather than multipart
      // on one of them.
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: {
          input: "from the relay",
          attachment: pngAttachment("relay-shot.png")
        }
      });

      await expectAttachmentReachedTheAgent(
        harness,
        task,
        "from the relay",
        "relay-shot"
      );
    } finally {
      task.events.close();
    }
  }, 90_000);

  it("refuses an oversized photo without storing it or writing the session", async () => {
    const task = await startAttachableTask(harness, "Oversized photo attachment");
    const transport = createLanClient(harness);

    try {
      await expect(
        transport.sendTaskInput(task.taskId, "too big", {
          fileName: "huge.png",
          mediaType: "image/png",
          // One byte past the server's documented 3 MiB budget.
          dataBase64: Buffer.alloc(3 * 1024 * 1024 + 1, 7).toString("base64")
        })
      ).rejects.toThrow(/413/);

      expect(await storedAttachments(harness, task.taskId)).toEqual([]);
      expect(task.events.outputText()).not.toContain("SCRIPT_INPUT:too big");
    } finally {
      task.events.close();
    }
  }, 90_000);

  it("removes a task's attachments when the task closes", async () => {
    const task = await startAttachableTask(harness, "Closed photo attachment");
    const transport = createLanClient(harness);

    try {
      await transport.sendTaskInput(
        task.taskId,
        "keep this",
        pngAttachment("closing-shot.png")
      );
      await expectAttachmentReachedTheAgent(
        harness,
        task,
        "keep this",
        "closing-shot"
      );
    } finally {
      task.events.close();
    }

    await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "POST",
      path: `/v1/tasks/${task.taskId}/actions/close`,
      body: null
    });

    await waitForCondition(
      async () => (await storedAttachments(harness, task.taskId)).length === 0,
      15_000,
      `attachments outlived the closed task ${task.taskId}`
    );
  }, 90_000);
});

// Referenced only to keep the transport's socket factory type honest above.
export type { WebSocketLike };
