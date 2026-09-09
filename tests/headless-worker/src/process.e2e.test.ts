import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  binary,
  freePort,
  listenersOnPort,
  processIsAlive,
  providerPath,
  run,
  waitFor,
} from "./worker.ts";

/**
 * Process-level regressions for the headless worker.
 *
 * Each of these is a defect that was reproduced with real binaries and is
 * invisible to a unit test, because what went wrong was which process got
 * signalled, which database got opened, or what mode a file was left in.
 * They start real workers against isolated roots rather than driving the
 * shared gate instance.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/** An isolated instance: its own data dir, database, ports and XDG roots. */
async function isolatedInstance() {
  const root = await mkdtemp(join(tmpdir(), "kanna-worker-process-"));
  const dataDir = join(root, "worker");
  const dbPath = join(root, "isolated.db");
  const xdgData = join(root, "xdg-data");
  const xdgRuntime = join(root, "xdg-runtime");
  const providerBin = join(root, "provider-bin");
  await mkdir(dataDir, { recursive: true });
  await mkdir(xdgData, { recursive: true });
  await mkdir(xdgRuntime, { recursive: true, mode: 0o700 });
  await mkdir(providerBin, { recursive: true });

  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KANNA_")),
  );
  env.PATH = providerPath(providerBin, process.env.PATH);
  env.XDG_DATA_HOME = xdgData;
  env.XDG_RUNTIME_DIR = xdgRuntime;

  const instance = {
    root,
    dataDir,
    dbPath,
    env,
    lanPort: await freePort(),
    transferPort: await freePort(),
  };
  cleanups.push(async () => {
    await run(binary("kanna-worker"), ["stop-daemon", "--data-dir", dataDir], env);
    await rm(root, { recursive: true, force: true });
  });
  return instance;
}

type Instance = Awaited<ReturnType<typeof isolatedInstance>>;

function runArgs(instance: Instance): string[] {
  return [
    "run",
    "--data-dir",
    instance.dataDir,
    "--db-path",
    instance.dbPath,
    "--lan-port",
    String(instance.lanPort),
    "--transfer-port",
    String(instance.transferPort),
  ];
}

/**
 * Start a supervisor through `/bin/sh` so the test can set a umask.
 *
 * 022 is the default on both platforms, and it is what turned a file the
 * worker meant to create 0600 into a world-readable one.
 */
async function startSupervisor(
  instance: Instance,
  options: { umask?: string; args?: string[] } = {},
): Promise<{ pid: number; output: () => string }> {
  const log: string[] = [];
  const command = [
    `umask ${options.umask ?? "022"}`,
    `exec ${[binary("kanna-worker"), ...(options.args ?? runArgs(instance))]
      .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
      .join(" ")}`,
  ].join("; ");
  const child = spawn("/bin/sh", ["-c", command], {
    env: instance.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => log.push(String(chunk)));
  child.stderr?.on("data", (chunk) => log.push(String(chunk)));
  cleanups.push(async () => {
    if (child.pid !== undefined && processIsAlive(child.pid)) {
      process.kill(child.pid, "SIGKILL");
    }
  });

  await waitFor(
    async () => (await listenersOnPort(instance.lanPort)).length === 1,
    () => `kanna-worker never served port ${instance.lanPort}\n${log.join("")}`,
  );
  return { pid: child.pid ?? -1, output: () => log.join("") };
}

/** Regular files the process has open, resolved through the platform's own view. */
async function openFiles(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    const listing = await run("/bin/sh", ["-c", `readlink -f /proc/${pid}/fd/* 2>/dev/null`], process.env);
    return listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  const listing = await run("/usr/sbin/lsof", ["-nP", "-p", String(pid), "-Fn"], process.env);
  return listing.stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));
}

describe("stop-daemon", () => {
  /**
   * `stop-daemon` used to SIGTERM whatever pid the record named. Reproduced
   * with a reviewer-owned `/bin/sleep` whose pid was placed in an isolated
   * record: it was killed, and the worker then reported "no daemon".
   */
  it("refuses to signal a process a stale record merely names", async () => {
    const instance = await isolatedInstance();
    const victim = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    cleanups.push(async () => {
      if (victim.pid !== undefined && processIsAlive(victim.pid)) {
        process.kill(victim.pid, "SIGKILL");
      }
    });
    await waitFor(async () => victim.pid !== undefined, "sleep should start");

    await writeFile(
      join(instance.dataDir, "supervisor.json"),
      JSON.stringify({
        pid: victim.pid,
        start: [1, 0],
        executable: binary("kanna-worker"),
        dataDir: instance.dataDir,
        data_dir: instance.dataDir,
      }),
    );

    const stopped = await run(
      binary("kanna-worker"),
      ["stop-daemon", "--data-dir", instance.dataDir],
      instance.env,
    );
    // No daemon is running, so the command reports that; what matters is what
    // it did *not* do on the way there.
    expect(stopped.stderr + stopped.stdout).not.toContain("asked supervisor");
    await sleep(1_000);
    expect(
      processIsAlive(victim.pid!),
      "a process the record merely names must not be signalled",
    ).toBe(true);
  });

  /** …while a real supervisor and its daemon still come down. */
  it("still tears down a supervisor and daemon it can prove", async () => {
    const instance = await isolatedInstance();
    const supervisor = await startSupervisor(instance);
    const daemonPid = Number.parseInt(
      (await readFile(join(instance.dataDir, "daemon.pid"), "utf8")).trim(),
      10,
    );
    expect(processIsAlive(daemonPid)).toBe(true);

    const stopped = await run(
      binary("kanna-worker"),
      ["stop-daemon", "--data-dir", instance.dataDir],
      instance.env,
    );
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stderr).toContain("asked supervisor");

    await waitFor(
      async () => !processIsAlive(supervisor.pid) && !processIsAlive(daemonPid),
      () =>
        `supervisor ${supervisor.pid} / daemon ${daemonPid} still running\n${supervisor.output()}`,
    );
  });
});

describe("the generated systemd unit", () => {
  /**
   * `render` used to drop `--db-path`, so an isolated worker installed as a
   * unit came back up against the machine's canonical desktop database. This
   * runs the generated `ExecStart` for real and asks the server which
   * database it opened.
   */
  it("launches against the database the install resolved", async () => {
    const instance = await isolatedInstance();
    const printed = await run(
      binary("kanna-worker"),
      [
        "print-unit",
        "--data-dir",
        instance.dataDir,
        "--db-path",
        instance.dbPath,
        "--lan-port",
        String(instance.lanPort),
        "--transfer-port",
        String(instance.transferPort),
      ],
      instance.env,
    );
    expect(printed.code, printed.stderr).toBe(0);

    const execStart = printed.stdout
      .split("\n")
      .find((line) => line.startsWith("ExecStart="))
      ?.slice("ExecStart=".length);
    expect(execStart, printed.stdout).toBeTruthy();
    expect(execStart).toContain(`--db-path ${instance.dbPath}`);

    // Run exactly what the unit would run.
    const [, ...args] = execStart!.split(" ");
    await startSupervisor(instance, { args });

    const [serverPid] = await listenersOnPort(instance.lanPort);
    expect(serverPid).toBeDefined();
    // `/var/folders/...` and `/private/var/folders/...` are the same file on
    // macOS; the platform's process view reports the resolved one.
    const open = await openFiles(serverPid!);
    const resolvedDb = await realpath(instance.dbPath);
    const resolvedRoot = await realpath(instance.root);
    expect(open, "the selected database must be the one opened").toContain(resolvedDb);
    const canonical = join(instance.env.XDG_DATA_HOME!, "build.kanna", "kanna-v2.db");
    expect(existsSync(canonical), `${canonical} must never be created`).toBe(false);
    expect(
      open.filter((path) => path.endsWith(".db") && !path.startsWith(resolvedRoot)),
      "no database outside this instance may be opened",
    ).toEqual([]);
  });
});

describe("server.toml", () => {
  /**
   * It carries `desktop_secret`. Under the default 022 umask the worker was
   * creating it 0644, which made the 0600 on the identity file pointless.
   */
  it("is private when created, and re-secured when it was left readable", async () => {
    const instance = await isolatedInstance();
    const configPath = join(instance.dataDir, "server.toml");

    await startSupervisor(instance, { umask: "022" });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(configPath, "utf8")).toContain("desktop_secret");

    // A file an earlier version left world-readable must not stay that way:
    // `OpenOptions::mode` only applies to a file the call creates.
    await run(binary("kanna-worker"), ["stop-daemon", "--data-dir", instance.dataDir], instance.env);
    await chmod(configPath, 0o644);
    expect((await stat(configPath)).mode & 0o777).toBe(0o644);

    await startSupervisor(instance, { umask: "022" });
    expect(
      (await stat(configPath)).mode & 0o777,
      "a pre-existing permissive config must be re-secured",
    ).toBe(0o600);
    expect(dirname(configPath)).toBe(instance.dataDir);
  });
});
