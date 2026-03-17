export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
}

export interface DiscordClientOptions {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
}

export class DiscordClient {
  constructor(private readonly opts: DiscordClientOptions) {}

  async postMessage(content: string): Promise<void> {
    if (this.opts.webhookUrl) {
      await this.postViaWebhook(content);
    } else if (this.opts.botToken && this.opts.channelId) {
      await this.postViaBotToken(content);
    } else {
      throw new Error(
        "DiscordClient requires either webhookUrl or both botToken and channelId"
      );
    }
  }

  private async postViaWebhook(content: string): Promise<void> {
    const response = await fetch(this.opts.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Discord webhook error ${response.status}: ${text}`
      );
    }
  }

  private async postViaBotToken(content: string): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${this.opts.channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.opts.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API error ${response.status}: ${text}`);
    }
  }

  async fetchMessages(after?: string): Promise<DiscordMessage[]> {
    if (!this.opts.botToken || !this.opts.channelId) {
      throw new Error(
        "fetchMessages requires botToken and channelId"
      );
    }

    const params = new URLSearchParams({ limit: "100" });
    if (after) {
      params.set("after", after);
    }

    const response = await fetch(
      `https://discord.com/api/v10/channels/${this.opts.channelId}/messages?${params.toString()}`,
      {
        headers: {
          Authorization: `Bot ${this.opts.botToken}`,
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<DiscordMessage[]>;
  }
}
