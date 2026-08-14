import type { AgentDefinition, WorkflowDefinition } from "./workflow-types";
import { parseAgentDefinition } from "./agent-loader";
import { parseWorkflowJson } from "./workflow-loader";

// Function types matching Tauri's file commands
type ReadFileFn = (path: string) => Promise<string>;
type ListDirFn = (path: string) => Promise<string[]>;

export interface ScanResult {
  agents: AgentDefinition[];
  workflows: WorkflowDefinition[];
  errors: string[];
}

export async function scanAgentsAndWorkflows(
  repoPath: string,
  readFile: ReadFileFn,
  listDir: ListDirFn,
): Promise<ScanResult> {
  const result: ScanResult = { agents: [], workflows: [], errors: [] };

  // Scan agents from {repoPath}/.kanna/agents/*/AGENT.md
  const agentsDir = `${repoPath}/.kanna/agents`;
  let agentDirs: string[];
  try {
    agentDirs = await listDir(agentsDir);
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const agentMdPath = `${agentsDir}/${dir}/AGENT.md`;
    let content: string;
    try {
      content = await readFile(agentMdPath);
    } catch {
      // No AGENT.md in this directory — silently skip
      continue;
    }

    try {
      const agent = parseAgentDefinition(content);
      result.agents.push(agent);
    } catch (err) {
      result.errors.push(
        `Failed to parse agent at ${agentMdPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Canonical workflow definitions shadow legacy `.kanna/pipelines` files
  // with the same name, allowing repositories to migrate incrementally.
  const workflowFiles = new Map<string, string>();
  for (const directory of ["pipelines", "workflows"]) {
    const definitionsDir = `${repoPath}/.kanna/${directory}`;
    let files: string[];
    try {
      files = await listDir(definitionsDir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file === "schema.json") continue;
      workflowFiles.set(file, `${definitionsDir}/${file}`);
    }
  }

  for (const [file, filePath] of workflowFiles) {
    if (!file.endsWith(".json") || file === "schema.json") continue;
    let content: string;
    try {
      content = await readFile(filePath);
    } catch {
      result.errors.push(`Failed to read workflow file ${filePath}`);
      continue;
    }

    try {
      const workflow = parseWorkflowJson(content);
      result.workflows.push(workflow);
    } catch (err) {
      result.errors.push(
        `Failed to parse workflow at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
