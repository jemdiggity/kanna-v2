import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadCapturedFixture } from "./fixtures.ts";

test("loads captured Codex ANSI fixture bytes without overwriting the file", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "kanna-tui-fixture-"));
  try {
    const fixturePath = path.join(fixtureDir, "codex-smoke.ansi");
    const fixtureBytes = new Uint8Array([0x1b, 0x5b, 0x48, 0x43, 0x6f, 0x64, 0x65, 0x78]);
    await writeFile(fixturePath, fixtureBytes);

    const fixture = await loadCapturedFixture(fixtureDir, {
      name: "codex-smoke",
      description: "Captured Codex CLI TUI smoke fixture.",
      snapshotAt: 3
    });

    assert.equal(fixture.name, "codex-smoke");
    assert.equal(fixture.description, "Captured Codex CLI TUI smoke fixture.");
    assert.equal(fixture.snapshotAt, 3);
    assert.deepEqual(fixture.bytes, fixtureBytes);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
