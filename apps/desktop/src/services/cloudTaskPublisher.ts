export interface CloudTaskPublisher {
  publish(snapshot: unknown): Promise<void>;
}

export interface CloudTaskPublisherDependencies {
  endpoint: string | null;
  getIdToken(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  postJson?: (endpoint: string, idToken: string, snapshot: unknown) => Promise<void>;
}

export function createCloudTaskPublisher({
  endpoint,
  getIdToken,
  fetchImpl = fetch,
  postJson,
}: CloudTaskPublisherDependencies): CloudTaskPublisher {
  return {
    async publish(snapshot) {
      if (!endpoint) {
        return;
      }

      const idToken = await getIdToken();
      if (!idToken) {
        return;
      }

      if (postJson) {
        await postJson(endpoint, idToken, snapshot);
        return;
      }

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${idToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `cloud task snapshot publish failed with status ${response.status}${body ? `: ${body}` : ""}`,
        );
      }
    },
  };
}
