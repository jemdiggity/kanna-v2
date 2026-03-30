import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("wake controls are present in the harness UI", () => {
  assert.match(html, /id="ctrlLBtn"/);
  assert.match(html, /id="enterBtn"/);
  assert.match(html, /id="escBtn"/);
  assert.match(html, /id="doubleWiggleBtn"/);
});
