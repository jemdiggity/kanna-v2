import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "./webdriver";
import { pairWithPeerThroughUi } from "./transferFlow";
import { callVueMethod, tauriInvoke } from "./vue";

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPort(name: string): number {
  const value = Number(readArg(name));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return value;
}

async function importRepo(client: WebDriverClient, repoPath: string, name: string): Promise<string> {
  const result = await callVueMethod(client, "store.importRepo", repoPath, name, "main");
  if (typeof result !== "string") throw new Error(`importRepo returned ${JSON.stringify(result)}`);
  await callVueMethod(client, "store.selectRepo", result);
  return result;
}

async function createTask(client: WebDriverClient, repoId: string, repoPath: string, prompt: string): Promise<string> {
  const result = await callVueMethod(
    client,
    "store.createItem",
    repoId,
    repoPath,
    prompt,
    "agent",
    { agentProvider: "codex", baseRef: "origin/main" },
  );
  if (typeof result !== "string") throw new Error(`createItem returned ${JSON.stringify(result)}`);
  const spawnResult = await tauriInvoke(client, "spawn_session", {
    sessionId: result,
    cwd: repoPath,
    executable: "/bin/zsh",
    args: ["--login", "-c", "printf 'LAN lab terminal ready\\n'; sleep 60"],
    env: {},
    cols: 80,
    rows: 24,
    agentProvider: "codex",
  });
  if (spawnResult && typeof spawnResult === "object" && "__error" in spawnResult) {
    throw new Error(String((spawnResult as { __error: unknown }).__error));
  }
  return result;
}

async function waitForLanDiagnostics(client: WebDriverClient, prompt: string): Promise<unknown> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await client.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const value = ctx.remoteTaskDiagnostics?.__v_isRef
        ? ctx.remoteTaskDiagnostics.value
        : ctx.remoteTaskDiagnostics;
      return JSON.parse(JSON.stringify((value || []).filter((entry) =>
        entry.prompt === ${JSON.stringify(prompt)}
      )));
    `);
    if (Array.isArray(last) && last.some((entry) =>
      entry?.selectedTerminalTransport === "lan" &&
      Array.isArray(entry.sources) &&
      entry.sources.includes("lan")
    )) return last;
    await sleep(500);
  }
  throw new Error(`LAN lab diagnostics missing for ${prompt}: ${JSON.stringify(last)}`);
}

const sourcePort = readPort("--source-port");
const observerPort = readPort("--observer-port");
const sourceRepo = readArg("--source-repo");
const observerRepo = readArg("--observer-repo");
const sourcePeer = readArg("--source-peer");
const observerPeer = readArg("--observer-peer");
const observerName = readArg("--observer-name");
const prompt = readArg("--prompt");

const source = new WebDriverClient(sourcePort);
const observer = new WebDriverClient(observerPort);
await source.createSession();
await observer.createSession();
try {
  const sourceRepoId = await importRepo(source, sourceRepo, "lan-lab-source");
  await importRepo(observer, observerRepo, "lan-lab-observer");
  await pairWithPeerThroughUi(source, observerName, observerPeer, {
    promptClient: observer,
    promptPeerId: sourcePeer,
  });
  await createTask(source, sourceRepoId, sourceRepo, prompt);
  const diagnostics = await waitForLanDiagnostics(observer, prompt);
  console.log(JSON.stringify({ ok: true, diagnostics }));
} finally {
  await source.deleteSession().catch(() => undefined);
  await observer.deleteSession().catch(() => undefined);
}
