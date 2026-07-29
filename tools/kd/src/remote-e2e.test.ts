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
        desktopPairing: false,
        ifChanged: false
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
        desktopPairing: false,
        ifChanged: false
      }
    });
    expect(parseCliArgs(["test", "remote-e2e", "--desktop-pairing"])).toEqual({
      taskId: "test.remote-e2e",
      input: {
        dev: true,
        staging: false,
        mobileRelay: false,
        desktopPairing: true,
        ifChanged: false
      }
    });
  });

  it("parses the path-aware selection flag for the dev lane only", () => {
    expect(parseCliArgs(["test", "remote-e2e", "--if-changed"])).toEqual({
      taskId: "test.remote-e2e",
      input: {
        dev: true,
        staging: false,
        mobileRelay: false,
        desktopPairing: false,
        ifChanged: true
      }
    });
    expect(() => parseCliArgs(["test", "remote-e2e", "--staging", "--if-changed"])).toThrow(
      "remote-e2e --if-changed applies to the dev lane only"
    );
  });
});
