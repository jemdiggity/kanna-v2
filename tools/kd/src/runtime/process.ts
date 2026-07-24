import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; streamOutput?: boolean; stdin?: string }
  ) => Promise<CommandResult>;
}

export async function findExecutable(
  runner: CommandRunner,
  name: string
): Promise<string | undefined> {
  const result = process.platform === "win32"
    ? await runner.run("where.exe", [name])
    : await runner.run("/bin/sh", ["-c", 'command -v -- "$1"', "kanna-doctor", name]);

  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export const nodeCommandRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdin.end(options?.stdin);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (options?.streamOutput) {
          process.stdout.write(chunk);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (options?.streamOutput) {
          process.stderr.write(chunk);
        }
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
};
