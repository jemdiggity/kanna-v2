import { setTimeout as sleep } from "node:timers/promises";

import { queryDb } from "./vue";
import type { WebDriverClient } from "./webdriver";

export interface PipelineItemRow {
  id: string;
  agent_provider: string | null;
  agent_type: string | null;
}

export async function waitForTaskCreated(
  client: WebDriverClient,
  prompt: string,
  timeoutMs = 10_000,
): Promise<PipelineItemRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT id, agent_provider, agent_type FROM pipeline_item WHERE prompt = ? ORDER BY created_at DESC LIMIT 1",
      [prompt],
    )) as PipelineItemRow[];
    if (rows[0]?.id) {
      return rows[0];
    }
    await sleep(200);
  }

  throw new Error(`timed out waiting for task prompt ${prompt}`);
}
