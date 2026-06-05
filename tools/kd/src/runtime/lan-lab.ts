import { z } from "zod";

const hostSchema = z.object({
  name: z.string().min(1),
  ssh: z.string().min(1),
  repo: z.string().min(1),
  webDriverPort: z.number().int().min(1).max(65535).default(4445),
});

const inventorySchema = z.object({
  hosts: z.array(hostSchema).min(2),
});

export type LanLabHost = z.infer<typeof hostSchema>;
export type LanLabInventory = z.infer<typeof inventorySchema>;

export interface LanLabPlanInput {
  runId: string;
  hosts: LanLabHost[];
  tunnelBasePort: number;
}

export interface LanLabWorkerPlan {
  host: LanLabHost;
  peerId: string;
  localWebDriverPort: number;
  startSshArgs: string[];
  tunnelArgs: string[];
}

export interface LanLabPlan {
  workers: LanLabWorkerPlan[];
}

export function parseLanLabInventory(raw: string): LanLabInventory {
  const parsed = inventorySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === "hosts" && issue.code === "too_small")) {
      throw new Error("LAN lab requires at least two hosts");
    }
    throw new Error(parsed.error.message);
  }
  if (new Set(parsed.data.hosts.map((host) => host.name)).size !== parsed.data.hosts.length) {
    throw new Error("LAN lab host names must be unique");
  }
  return parsed.data;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function buildLanLabPlan(input: LanLabPlanInput): LanLabPlan {
  return {
    workers: input.hosts.map((host, index) => {
      const name = safeName(host.name);
      const daemonDir = `.kanna-lab/${input.runId}/${name}/daemon`;
      const transferRoot = `.kanna-lab/${input.runId}/${name}/transfer`;
      const dbName = `kanna-test-lab-${input.runId}-${name}.db`;
      const localWebDriverPort = input.tunnelBasePort + index;
      const command = [
        `cd ${shellQuote(host.repo)}`,
        [
          `KANNA_WEBDRIVER_PORT=${shellQuote(String(host.webDriverPort))}`,
          "KANNA_TRANSFER_DISCOVERY='mdns'",
          `KANNA_TRANSFER_PEER_ID=${shellQuote(name)}`,
          `KANNA_TRANSFER_DISPLAY_NAME=${shellQuote(host.name)}`,
          "./kd dev up",
          `--db ${shellQuote(dbName)}`,
          "--delete-db",
          `--daemon-dir ${shellQuote(daemonDir)}`,
          `--transfer-root ${shellQuote(transferRoot)}`,
        ].join(" "),
      ].join(" && ");
      return {
        host,
        peerId: name,
        localWebDriverPort,
        startSshArgs: [host.ssh, command],
        tunnelArgs: [
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${localWebDriverPort}:127.0.0.1:${host.webDriverPort}`,
          host.ssh,
        ],
      };
    }),
  };
}
