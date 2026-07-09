import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli";

describe("kd remote-e2e test command", () => {
  it("keeps the default dev Layer B smoke lane", () => {
    expect(parseCliArgs(["test", "remote-e2e"])).toEqual({
      taskId: "test.remote-e2e",
      input: {
        dev: true,
        staging: false,
        mobileRelay: false,
        desktopPairing: false
      }
    });
  });

  it("parses explicit Layer C and Layer D lanes", () => {
    expect(parseCliArgs(["test", "remote-e2e", "--mobile-relay"])).toEqual({
      taskId: "test.remote-e2e",
      input: {
        dev: true,
        staging: false,
        mobileRelay: true,
        desktopPairing: false
      }
    });
    expect(parseCliArgs(["test", "remote-e2e", "--desktop-pairing"])).toEqual({
      taskId: "test.remote-e2e",
      input: {
        dev: true,
        staging: false,
        mobileRelay: false,
        desktopPairing: true
      }
    });
  });
});
