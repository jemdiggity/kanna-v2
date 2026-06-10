export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
}

export interface SlackClientOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly options: SlackClientOptions = {}
  ) {}

  private requestSignal(): AbortSignal {
    return AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async postMessage(channel: string, text: string): Promise<void> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      signal: this.requestSignal(),
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    });

    if (!response.ok) {
      throw new Error(`Slack HTTP error ${response.status}`);
    }

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

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params.toString()}`,
      {
        signal: this.requestSignal(),
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Slack HTTP error ${response.status}`);
    }

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
