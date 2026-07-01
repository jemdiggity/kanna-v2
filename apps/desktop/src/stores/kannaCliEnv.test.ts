import { describe, expect, it } from "vitest";
import { buildKannaCliEnv, buildTaskRuntimeEnv, resolveKannaServerBaseUrl } from "./kannaCliEnv";

describe("buildKannaCliEnv", () => {
  it("passes task identity and server routing without direct DB access", () => {
    expect(
      buildKannaCliEnv({
        taskId: "task-123",
        socketPath: "/tmp/kanna.sock",
        serverBaseUrl: "http://127.0.0.1:48120",
      }),
    ).toEqual({
      KANNA_TASK_ID: "task-123",
      KANNA_SOCKET_PATH: "/tmp/kanna.sock",
      KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
    });
  });
});

describe("buildTaskRuntimeEnv", () => {
  it("includes task-scoped worktree, port, and kanna-cli env", () => {
    expect(
      buildTaskRuntimeEnv({
        taskId: "task-123",
        socketPath: "/tmp/kanna.sock",
        serverBaseUrl: "http://127.0.0.1:48120",
        portEnv: {
          KANNA_DEV_PORT: "1421",
          API_PORT: "3001",
        },
        kannaCliPath: "/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin",
      }),
    ).toEqual({
      KANNA_WORKTREE: "1",
      KANNA_DEV_PORT: "1421",
      API_PORT: "3001",
      KANNA_CLI_PATH: "/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin",
      KANNA_TASK_ID: "task-123",
      KANNA_SOCKET_PATH: "/tmp/kanna.sock",
      KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
    });
  });

  it("points kanna-cli at the configured app server port", () => {
    expect(
      buildTaskRuntimeEnv({
        taskId: "task-123",
        socketPath: "/tmp/kanna.sock",
        serverBaseUrl: "http://127.0.0.1:48121",
        portEnv: {
          KANNA_DEV_PORT: "1421",
          KANNA_MOBILE_SERVER_PORT: "48121",
        },
        kannaCliPath: "/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin",
      }),
    ).toEqual({
      KANNA_WORKTREE: "1",
      KANNA_DEV_PORT: "1421",
      KANNA_MOBILE_SERVER_PORT: "48121",
      KANNA_CLI_PATH: "/Applications/Kanna.app/Contents/MacOS/kanna-cli-aarch64-apple-darwin",
      KANNA_TASK_ID: "task-123",
      KANNA_SOCKET_PATH: "/tmp/kanna.sock",
      KANNA_SERVER_BASE_URL: "http://127.0.0.1:48121",
    });
  });
});

describe("resolveKannaServerBaseUrl", () => {
  it("uses the app process mobile server port when present", () => {
    expect(resolveKannaServerBaseUrl("48129")).toBe("http://127.0.0.1:48129");
  });

  it("uses the production server port when the app has no port override", () => {
    expect(resolveKannaServerBaseUrl(null)).toBe("http://127.0.0.1:48120");
  });

  it("keeps the explicit production server port", () => {
    expect(resolveKannaServerBaseUrl("48120")).toBe("http://127.0.0.1:48120");
  });
});
