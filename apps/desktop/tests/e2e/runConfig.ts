import { join } from "node:path";

export interface InstanceConfig {
  baseUrl: string;
  daemonDir: string;
  /** The dev server this instance's window must load — see `runStartup`. */
  devUrl: string;
  env: Record<string, string>;
  sessionName: string;
  startCommand: string[];
  stopCommand: string[];
  webDriverPort: number;
}

export interface CreateInstanceConfigInput {
  daemonDir: string;
  dbName: string;
  devPortEnvValue: number;
  effectiveWebDriverPort: number;
  env: Record<string, string>;
  mobileServerPortEnvValue: number;
  sessionName: string;
  transferPortEnvValue: number;
  webDriverPortEnvValue: number;
}

export function createInstanceConfig(input: CreateInstanceConfigInput): InstanceConfig {
  return {
    baseUrl: `http://127.0.0.1:${input.effectiveWebDriverPort}`,
    daemonDir: input.daemonDir,
    // `kd dev up` writes this URL into tauri.conf.local.json for `tauri dev`.
    devUrl: `http://localhost:${input.devPortEnvValue}`,
    env: input.env,
    sessionName: input.sessionName,
    startCommand: [
      "./kd",
      "dev",
      "up",
      "--db",
      input.dbName,
      "--delete-db",
      "--daemon-dir",
      input.daemonDir,
      "--transfer-root",
      join(input.daemonDir, "transfer-root"),
    ],
    stopCommand: [
      "./kd",
      "dev",
      "down",
      "--kill-daemon",
    ],
    webDriverPort: input.effectiveWebDriverPort,
  };
}
