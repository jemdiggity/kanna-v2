import { ref } from "vue";
import { invoke } from "../invoke";
import { parseAgentMd, type CustomTaskConfig } from "@kanna/core";

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
      const tasksDir = `${repoPath}/.kanna/tasks`;
      let entries: string[];
      try {
        entries = await invoke<string[]>("list_dir", { path: tasksDir });
      } catch {
        tasks.value = [];
        return;
      }
      if (controller.signal.aborted) return;
      const found: CustomTaskConfig[] = [];
      for (const entry of entries) {
        if (controller.signal.aborted) return;
        const agentMdPath = `${tasksDir}/${entry}/agent.md`;
        let content: string;
        try {
          content = await invoke<string>("read_text_file", { path: agentMdPath });
        } catch { continue; }
        if (controller.signal.aborted) return;
        const config = parseAgentMd(content, entry);
        if (config) found.push(config);
        else console.warn(`[useCustomTasks] Skipped malformed ${agentMdPath}`);
      }
      if (!controller.signal.aborted) {
        tasks.value = found;
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
