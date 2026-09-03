import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDatabase } from "../helpers/reset";
import { callVueMethod, queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const remoteRepoId = "lan:remote-reorder-repo";
const remoteUrlHash = "remote-reorder-hash";

function remoteSnapshot() {
  return {
    repos: [
      ["lan:remote-first", "Remote First", "remote-first-hash"],
      ["lan:remote-last", "Remote Last", "remote-last-hash"],
      [remoteRepoId, "Remote Reorder Repo", remoteUrlHash],
    ].map(([id, name, hash], index) => ({
      id,
      path: "cloud",
      name,
      default_branch: "main",
      remote_url: `git@github.com:owner/${id}.git`,
      remote_url_hash: hash,
      hidden: 0,
      sort_order: index,
      created_at: `2026-09-03T00:0${index}:00.000Z`,
      last_opened_at: `2026-09-03T00:0${index}:00.000Z`,
    })),
    items: [],
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

async function renderedRepoIds(client: WebDriverClient): Promise<string[]> {
  return client.executeSync<string[]>(
    `return [...document.querySelectorAll(".sidebar .repo-section")]
      .map((element) => element.getAttribute("data-repo-id"));`,
  );
}

describe("remote-only repository reorder", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("persists and restores a remote-only repo among sibling repos", async () => {
    await sleep(1_250);
    await client.executeSync(
      `window.__KANNA_E2E__.setupState.__e2eInjectRemoteSnapshot(
         "lan",
         ${JSON.stringify(remoteSnapshot())},
         { freezeLanRefresh: true },
       );`,
    );
    await client.waitForElement(
      `.sidebar .repo-section[data-repo-id="${remoteRepoId}"]`,
      5_000,
    );

    const initialIds = await renderedRepoIds(client);
    expect(initialIds).toEqual(["lan:remote-first", "lan:remote-last", remoteRepoId]);
    expect(initialIds.at(-1)).toBe(remoteRepoId);
    const orderedIds = [remoteRepoId, ...initialIds.filter((id) => id !== remoteRepoId)];
    const result = await callVueMethod(client, "reorderSidebarRepos", orderedIds);
    expect(result).not.toMatchObject({ __error: expect.any(String) });

    expect((await renderedRepoIds(client))[0]).toBe(remoteRepoId);
    expect(await queryDb(
      client,
      "SELECT sort_order FROM repo_sidebar_order WHERE remote_url_hash = ?",
      [remoteUrlHash],
    )).toEqual([{ sort_order: 0 }]);

    await callVueMethod(client, "store.reloadSnapshot");
    expect((await renderedRepoIds(client))[0]).toBe(remoteRepoId);
  });
});
