import { ref } from "vue";
import { invoke } from "../invoke";
import { parseAgentMd, type CustomTaskConfig } from "@kanna/core";

async function readTaskConfig(path: string, dirName: string): Promise<CustomTaskConfig | null> {
  const content = await invoke<string>("read_text_file", { path });
  return parseAgentMd(content, dirName);
}

async function readBuiltinTaskConfig(relativePath: string, dirName: string): Promise<CustomTaskConfig | null> {
  const content = await invoke<string>("read_builtin_resource", { relativePath });
  return parseAgentMd(content, dirName);
}

export function useCustomTasks() {
  const tasks = ref<CustomTaskConfig[]>([]);
  const scanning = ref(false);
  let currentController: AbortController | null = null;

  async function scan(repoPath: string) {
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    const controller = new AbortController();
    currentController = controller;
    scanning.value = true;
    try {
      const found = new Map<string, CustomTaskConfig>();

      try {
        const builtinEntries = await invoke<string[]>("list_builtin_resources", {
          relativePath: ".kanna/tasks",
        });
        if (controller.signal.aborted) return;
        for (const entry of builtinEntries) {
          if (controller.signal.aborted) return;
          const agentMdPath = `.kanna/tasks/${entry}/agent.md`;
          try {
            const config = await readBuiltinTaskConfig(agentMdPath, entry);
            if (config) found.set(entry, config);
            else console.warn(`[useCustomTasks] Skipped malformed built-in ${agentMdPath}`);
          } catch (error) {
            console.debug(`[useCustomTasks] Failed to read built-in task ${agentMdPath}:`, error);
            continue;
          }
        }
      } catch (error) {
        console.debug("[useCustomTasks] No bundled tasks available in this runtime:", error);
      }

      const tasksDir = `${repoPath}/.kanna/tasks`;
      try {
        const entries = await invoke<string[]>("list_dir", { path: tasksDir });
        if (controller.signal.aborted) return;
        for (const entry of entries) {
          if (controller.signal.aborted) return;
          const agentMdPath = `${tasksDir}/${entry}/agent.md`;
          try {
            const config = await readTaskConfig(agentMdPath, entry);
            if (config) found.set(entry, config);
            else console.warn(`[useCustomTasks] Skipped malformed ${agentMdPath}`);
          } catch (error) {
            console.debug(`[useCustomTasks] Failed to read custom task ${agentMdPath}:`, error);
            continue;
          }
        }
      } catch (error) {
        console.debug("[useCustomTasks] Repo has no custom tasks; keeping bundled defaults:", error);
      }

      if (!controller.signal.aborted) {
        tasks.value = Array.from(found.values());
      }
    } finally {
      if (currentController === controller) {
        scanning.value = false;
        currentController = null;
      }
    }
  }

  function cancel() {
    if (currentController) {
      currentController.abort();
      currentController = null;
      scanning.value = false;
    }
  }

  return { tasks, scanning, scan, cancel };
}
