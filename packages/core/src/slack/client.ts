import { assertOk, httpRequest } from "../http/client.js";

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
}

export interface SlackClientOptions {
  timeoutMs?: number;
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly options: SlackClientOptions = {}
  ) {}

  async postMessage(channel: string, text: string): Promise<void> {
    const response = await httpRequest("https://slack.com/api/chat.postMessage", {
      method: "POST",
      timeoutMs: this.options.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    });

    await assertOk(response, "Slack HTTP");

    const data = (await response.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error ?? "unknown"}`);
    }
  }

  async fetchHistory(
    channel: string,
    oldest?: string
  ): Promise<SlackMessage[]> {
    const params = new URLSearchParams({ channel, limit: "100" });
    if (oldest) {
      params.set("oldest", oldest);
    }

    const response = await httpRequest(
      `https://slack.com/api/conversations.history?${params.toString()}`,
      {
        timeoutMs: this.options.timeoutMs,
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      }
    );

    await assertOk(response, "Slack HTTP");

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      messages?: SlackMessage[];
    };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error ?? "unknown"}`);
    }

    return data.messages ?? [];
  }
}
