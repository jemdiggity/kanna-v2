/**
 * Mobile ↔ desktop wiring for the create-task composer's agent choices.
 *
 * A desktop with a restricted provider set must not offer the missing ones in
 * the mobile composer. This runs the real chain for that claim: a real
 * `kanna-daemon` and `kanna-server` on an isolated PATH holding exactly one
 * agent CLI, the app's real LAN transport and client over HTTP, the real
 * session store and controller, and the real `CreateTaskComposer`.
 *
 * It needs Rust binaries, so it is opt-in like the other integration spec here:
 *
 *   pnpm --dir apps/mobile run test:integration:agent-provider-inventory
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localProcessFetch } from "@kanna/local-process-fetch";

vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    absoluteFill: "absoluteFill",
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  View: "View"
}));

const RUN_INTEGRATION =
  process.env.KANNA_RUN_AGENT_PROVIDER_INVENTORY_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The one agent CLI this fixture desktop can run. */
const INSTALLED_PROVIDER = "opencode";
const MISSING_PROVIDERS = ["claude", "copilot", "codex", "antigravity"];

interface ElementNode {
  type: unknown;
  props?: {
    children?: ElementNode | ElementNode[] | string | null;
    [key: string]: unknown;
  };
}

function flattenChildren(
  children: ElementNode | ElementNode[] | string | null | undefined
): ElementNode[] {
  if (!children || typeof children === "string") return [];
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

function findNodeByTestId(node: ElementNode, testID: string): ElementNode | null {
  if (node.props?.testID === testID) return node;
  for (const child of flattenChildren(node.props?.children)) {
    const match = findNodeByTestId(child, testID);
    if (match) return match;
  }
  return null;
}

function resolveRustBinary(name: string): string {
  const candidates = [
    process.env[`KANNA_E2E_${name.toUpperCase().replace(/-/g, "_")}_BINARY`],
    join(repoRoot, ".build", "debug", name),
    join(repoRoot, ".build", "aarch64-apple-darwin", "debug", name),
    join(repoRoot, ".build", "x86_64-apple-darwin", "debug", name)
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `${name} was not found in ${candidates.join(", ")}. Build it first: cargo build -p ${name}`
    );
  }
  return found;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function waitForServer(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`kanna-server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await localProcessFetch(`${baseUrl}/v1/status`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(150);
  }
  throw new Error(`kanna-server never became ready at ${baseUrl}`);
}

describeIntegration("mobile composer agent options against a real desktop", () => {
  let root = "";
  let baseUrl = "";
  let repoPath = "";
  let daemon: ChildProcess | null = null;
  let server: ChildProcess | null = null;

  beforeAll(async () => {
    const serverBinary = resolveRustBinary("kanna-server");
    const daemonBinary = resolveRustBinary("kanna-daemon");

    root = await mkdtemp(join(tmpdir(), "kanna-mobile-inventory-"));
    const runtimeBin = join(root, "runtime-bin");
    const home = join(root, "home");
    const daemonDir = join(root, "daemon");
    repoPath = join(root, "repo");
    await mkdir(runtimeBin);
    await mkdir(home);
    await mkdir(daemonDir);
    await mkdir(repoPath);

    // An isolated PATH — process PATH, login-shell PATH, and HOME alike — that
    // holds exactly one agent CLI. This is the machine the phone will see.
    await copyFile(serverBinary, join(runtimeBin, "kanna-server"));
    await chmod(join(runtimeBin, "kanna-server"), 0o755);
    await symlink("/usr/bin/git", join(runtimeBin, "git"));
    await writeExecutable(join(runtimeBin, INSTALLED_PROVIDER), "#!/bin/sh\nexit 0\n");
    await writeExecutable(join(root, "kanna-cli"), "#!/bin/sh\nexit 0\n");
    const loginPath = `export PATH="${runtimeBin}"\n`;
    await writeFile(join(home, ".zprofile"), loginPath);
    await writeFile(join(home, ".zshrc"), loginPath);

    const env = {
      HOME: home,
      ZDOTDIR: home,
      XDG_DATA_HOME: join(root, "xdg-data"),
      PATH: runtimeBin,
      KANNA_DAEMON_DIR: daemonDir
    };

    // The daemon refuses the protected-input handshake unless it has a pinned
    // kanna-server executable, and the server does not open its LAN listener
    // until that handshake succeeds.
    daemon = spawn(daemonBinary, [], {
      env: { ...env, KANNA_SERVER_EXECUTABLE: join(runtimeBin, "kanna-server") },
      stdio: "ignore"
    });

    const lanPort = await freePort();
    const transferPort = await freePort();
    baseUrl = `http://127.0.0.1:${lanPort}`;
    await writeFile(
      join(root, "server.toml"),
      [
        'relay_url = ""',
        'device_token = "integration-device-token"',
        `daemon_dir = "${daemonDir}"`,
        `db_path = "${join(root, "kanna.db")}"`,
        `kanna_cli_path = "${join(root, "kanna-cli")}"`,
        'desktop_id = "desktop-mobile-inventory"',
        'desktop_secret = "desktop-secret"',
        'desktop_name = "Inventory Mac"',
        'version = "integration"',
        'environment = "development"',
        'lan_host = "127.0.0.1"',
        `lan_port = ${lanPort}`,
        `transfer_port = ${transferPort}`,
        `pairing_store_path = "${join(root, "pairings.json")}"`,
        ""
      ].join("\n")
    );

    server = spawn(join(runtimeBin, "kanna-server"), [], {
      env: { ...env, KANNA_SERVER_CONFIG: join(root, "server.toml") },
      stdio: "ignore"
    });
    await waitForServer(baseUrl, server);

    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "integration@kanna.build"],
      ["config", "user.name", "Kanna Integration"],
      ["commit", "--allow-empty", "-m", "fixture"]
    ]) {
      await new Promise<void>((resolveGit, reject) => {
        const git = spawn("git", args, { cwd: repoPath, stdio: "ignore" });
        git.once("error", reject);
        git.once("exit", (code) =>
          code === 0 ? resolveGit() : reject(new Error(`git ${args[0]} failed: ${code}`))
        );
      });
    }
    const addRepo = await localProcessFetch(`${baseUrl}/v1/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repoPath, name: "Inventory Repo" })
    });
    if (!addRepo.ok) {
      throw new Error(`repo registration failed: ${addRepo.status}`);
    }
  }, 120_000);

  afterAll(async () => {
    server?.kill("SIGKILL");
    daemon?.kill("SIGKILL");
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("offers only the agent the desktop can actually run", async () => {
    const { createLanTransport } = await import("../src/lib/transports/lanTransport");
    const { createKannaClient } = await import("../src/lib/api/client");
    const { createSessionStore } = await import("../src/state/sessionStore");
    const { createMobileController } = await import("../src/state/mobileController");
    const { CreateTaskComposer } = await import("../src/components/CreateTaskComposer");

    const client = createKannaClient(createLanTransport(baseUrl, localProcessFetch));

    // 1. The desktop reports its own inventory over the LAN payloads.
    const desktops = await client.listDesktops();
    expect(desktops).toHaveLength(1);
    expect(desktops[0].agentProviders).toEqual([INSTALLED_PROVIDER]);

    // 2. The controller defaults the composer to what that machine can run,
    //    rather than to a hardcoded provider it cannot.
    const store = createSessionStore();
    const controller = createMobileController(client, store);
    await controller.bootstrap();
    const repos = store.getState().repos;
    expect(repos).toHaveLength(1);
    store.selectRepo(repos[0].id);
    controller.openComposer();
    expect(store.getState().composerAgentProvider).toBe(INSTALLED_PROVIDER);

    // 3. The composer renders exactly those choices.
    const state = store.getState();
    const tree = CreateTaskComposer({
      isOpen: true,
      prompt: "Ship the App Store build",
      repos: state.repos,
      desktops: state.desktops,
      selectedRepoId: state.composerRepoId,
      selectedDesktopId: state.composerDesktopId,
      selectedAgentProvider: state.composerAgentProvider,
      isOptionsExpanded: true,
      errorMessage: state.composerErrorMessage,
      onClose: vi.fn(),
      onSelectDesktop: vi.fn(),
      onSelectAgentProvider: vi.fn(),
      onToggleOptions: vi.fn(),
      onChangePrompt: vi.fn(),
      onSubmit: vi.fn()
    }) as ElementNode;

    expect(
      findNodeByTestId(tree, `mobile.create-task.agent.${INSTALLED_PROVIDER}`)
    ).not.toBeNull();
    for (const provider of MISSING_PROVIDERS) {
      expect(
        findNodeByTestId(tree, `mobile.create-task.agent.${provider}`)
      ).toBeNull();
    }

    controller.dispose();
  }, 60_000);
});
