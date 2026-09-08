import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScriptedAgentBinary } from "@kanna/remote-e2e/src/scriptedAgent.ts";
import { run, writeExecutable } from "./worker.ts";

/**
 * A git repository shaped like the work Kanna actually runs: a two-stage
 * workflow with a manual gate, and scripted agent CLIs standing in for the
 * real ones.
 *
 * Scripted providers rather than a real `claude` is a correctness choice, not
 * only a cost one: the gate asserts what the *system* records — durable input
 * rows, terminal stage runs, forked branches — and a real model would make
 * every one of those assertions depend on what it happened to say.
 */
export interface FixtureRepo {
  path: string;
  /** Directory holding the scripted provider executables. */
  providerBinDir: string;
  /** Every line the scripted agent has read from its PTY, in order. */
  agentInput(): Promise<string[]>;
}

const AGENT_PROVIDERS = ["claude", "codex", "copilot", "opencode", "agy"];

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), "kanna-headless-repo-"));
  const path = join(root, "repo");
  const providerBinDir = join(root, "provider-bin");
  const inputTraceFile = join(root, "agent-input.trace");
  await mkdir(path, { recursive: true });
  await mkdir(providerBinDir, { recursive: true });

  // Every provider gets the scripted agent behind a `--version` shim. The
  // daemon probes a provider's version before spawning one, and the scripted
  // agent on its own answers that probe by starting an interactive session
  // that never exits.
  for (const provider of AGENT_PROVIDERS) {
    const implementation = join(providerBinDir, `${provider}-impl`);
    await writeScriptedAgentBinary(implementation, {
      inputTraceFile,
      terminalPasteSemantics: true,
    });
    await writeExecutable(
      join(providerBinDir, provider),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf \'1.0.0 (headless gate)\\n\'; exit 0; fi',
        `exec ${implementation} "$@"`,
        "",
      ].join("\n"),
    );
  }

  await mkdir(join(path, ".kanna", "workflows"), { recursive: true });
  await mkdir(join(path, ".kanna", "agents", "builder"), { recursive: true });
  await mkdir(join(path, ".kanna", "agents", "reviewer"), { recursive: true });
  await writeFile(
    join(path, ".kanna", "config.json"),
    JSON.stringify({ agentProviders: { "*": "claude" } }, null, 2),
  );
  await writeFile(
    join(path, ".kanna", "workflows", "gate.json"),
    JSON.stringify(
      {
        name: "gate",
        stages: [
          {
            name: "in progress",
            agent: "builder",
            prompt: "$TASK_PROMPT",
            policy: { transition: "manual" },
          },
          {
            name: "review",
            agent: "reviewer",
            prompt: "Review $PREV_MAIN_RESULT",
            policy: { transition: "manual" },
          },
        ],
      },
      null,
      2,
    ),
  );
  for (const agent of ["builder", "reviewer"]) {
    await writeFile(
      join(path, ".kanna", "agents", agent, "AGENT.md"),
      `---\nname: ${agent}\ndescription: Headless gate ${agent}\nagent_provider: claude\n---\nRun ${agent}.\n`,
    );
  }
  await writeFile(join(path, "README.md"), "headless worker gate fixture\n");

  const git = (args: string[]) =>
    run("git", args, { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, path);
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "gate@example.invalid"]);
  await git(["config", "user.name", "Headless Gate"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture"]);
  // Kanna forks task workspaces from the repository's published main, so the
  // fixture needs an origin even though nothing is ever pushed anywhere real.
  const origin = join(root, "origin.git");
  await run("git", ["init", "--bare", "-b", "main", origin], process.env);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "-u", "origin", "main"]);

  return {
    path,
    providerBinDir,
    async agentInput() {
      const { readFile } = await import("node:fs/promises");
      try {
        const trace = await readFile(inputTraceFile, "utf8");
        return trace.split("\0").filter((line) => line.length > 0);
      } catch {
        return [];
      }
    },
  };
}

/** A provider executable that is not the scripted agent, for negative cases. */
export async function writeInertProvider(path: string): Promise<void> {
  await writeExecutable(path, "#!/bin/sh\nexit 0\n");
}
