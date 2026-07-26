import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRustTestCommands } from "../src/runtime/rust-test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

function workflowJob(workflow: string, jobName: string): string {
  const jobHeader = `  ${jobName}:\n`;
  const jobStart = workflow.indexOf(jobHeader);
  if (jobStart === -1) throw new Error(`missing ${jobName} job`);

  const remainingWorkflow = workflow.slice(jobStart + jobHeader.length);
  const nextJobOffset = remainingWorkflow.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJobOffset === -1
    ? workflow.slice(jobStart)
    : workflow.slice(jobStart, jobStart + jobHeader.length + nextJobOffset);
}

describe("canonical CI workflow", () => {
  it("runs the same bounded JavaScript and Rust commands used locally", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("run: pnpm test");
    expect(workflow).toContain("run: ./kd test rust");
    expect(buildRustTestCommands()).toContainEqual({
      name: "agent-protocol",
      command: "./scripts/check-agent-protocol-types.sh",
      args: [],
    });
    expect(workflow).not.toContain("pnpm test:agent-cli-compat");
    expect(workflow).not.toContain("pnpm test:remote-e2e");
    expect(workflow).not.toContain("pnpm test:tui-fidelity");
    expect(workflow.match(/pnpm install --frozen-lockfile/g)).toHaveLength(2);
  });

  it("installs shell and command-runtime prerequisites in the JavaScript job", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const javascriptJob = workflowJob(workflow, "javascript");

    expect(javascriptJob).toContain(
      "sudo apt-get install -y --no-install-recommends zsh tmux",
    );
  });

  it("runs authenticated daemon handoff coverage on macOS with shipped history", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const rustJob = workflowJob(workflow, "rust");
    const daemonHandoffJob = workflowJob(workflow, "daemon-handoff");

    expect(rustJob).toContain("runs-on: ubuntu-latest");
    expect(rustJob).toContain("run: ./kd test rust");
    expect(rustJob).not.toContain("fetch-depth: 0");
    expect(daemonHandoffJob).toContain("runs-on: macos-14");
    expect(daemonHandoffJob).toContain("fetch-depth: 0");
    expect(daemonHandoffJob).toContain(
      "run: cd crates/daemon && cargo test -- --test-threads=1",
    );
  });
});
