import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [modulePath, path, socket, gateAt] = process.argv.slice(2);
const readFile = fs.readFileSync;
const realNow = Date.now;
const lockTime = realNow();
// Scheduling a gated writer must not spend the product's lock-wait budget.
// The parent and the gate below still use real hang-containment deadlines.
Date.now = () => lockTime;
let ownerReads = 0;
let gated = false;
function signal(event) {
  fs.writeSync(1, `${event}\n`);
}
function gate() {
  gated = true;
  signal("gated");
  // Files are release signals; this ceiling only contains a broken harness.
  const deadline = realNow() + 30_000;
  while (!fs.existsSync(`${path}.${socket}.release`)) {
    if (realNow() > deadline) throw new Error(`unreleased writer ${socket}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
fs.readFileSync = function (file, ...args) {
  const result = readFile.call(this, file, ...args);
  const owner = String(file).startsWith(`${path}.lock/`);
  if (owner && ++ownerReads === 2) signal("contended-again");
  if (!gated && ((gateAt === "owner" && owner) || (gateAt === "inventory" && String(file) === path))) gate();
  return result;
};
syncBuiltinESMExports();
const { recordInventoryResource } = await import(modulePath);
recordInventoryResource(path, { kind: "tmux-server", socket });
signal("written");
