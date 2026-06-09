import { describe, expect, it } from "vitest";
import * as functions from "../src/index.js";

describe("firebase function exports", () => {
  it("does not export the obsolete task snapshot HTTP publisher", () => {
    expect(functions).not.toHaveProperty("upsertTaskSnapshot");
  });
});
