import test from "node:test";
import assert from "node:assert/strict";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

test("node-pty can spawn an interactive shell and stream output", async () => {
  const chunks = [];

  await new Promise((resolve, reject) => {
    let settled = false;
    const child = pty.spawn("/bin/zsh", ["--login", "-c", "printf hello\\r\\n; exec cat"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        TERM_PROGRAM: "xterm",
      },
    });

    child.onData((data) => {
      chunks.push(data);
      if (data.includes("hello")) {
        settled = true;
        child.kill();
        resolve();
      }
    });

    child.onExit(({ exitCode, signal }) => {
      if (settled) return;
      settled = true;
      reject(new Error(`pty exited before hello: code=${exitCode} signal=${signal}`));
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out waiting for hello, got: ${JSON.stringify(chunks)}`));
    }, 3000);
  });

  assert.ok(chunks.some((chunk) => chunk.includes("hello")));
});
