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
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      streamOutput?: boolean;
      stdin?: string;
      interactive?: boolean;
    }
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
        stdio: options?.interactive ? "inherit" : ["pipe", "pipe", "pipe"]
      });
      if (options?.interactive) {
        child.on("error", reject);
        child.on("close", (exitCode) => {
          resolve({ exitCode: exitCode ?? 1, stdout: "", stderr: "" });
        });
        return;
      }
      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      if (!childStdin || !childStdout || !childStderr) {
        child.kill();
        reject(new Error(`Failed to open pipes for ${command}.`));
        return;
      }
      let stdout = "";
      let stderr = "";
      childStdin.end(options?.stdin);
      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (options?.streamOutput) {
          process.stdout.write(chunk);
        }
      });
      childStderr.on("data", (chunk: string) => {
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
