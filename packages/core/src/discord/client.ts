import { assertOk, httpRequest } from "../http/client.js";

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
  timeoutMs?: number;
}

export class DiscordClient {
  constructor(private readonly opts: DiscordClientOptions) {}

  async postMessage(content: string): Promise<void> {
    const { webhookUrl, botToken, channelId } = this.opts;
    if (webhookUrl) {
      await this.postViaWebhook(webhookUrl, content);
    } else if (botToken && channelId) {
      await this.postViaBotToken(botToken, channelId, content);
    } else {
      throw new Error(
        "DiscordClient requires either webhookUrl or both botToken and channelId"
      );
    }
  }

  private async postViaWebhook(webhookUrl: string, content: string): Promise<void> {
    const response = await httpRequest(webhookUrl, {
      method: "POST",
      timeoutMs: this.opts.timeoutMs,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    await assertOk(response, "Discord webhook", { includeBody: true });
  }

  private async postViaBotToken(
    botToken: string,
    channelId: string,
    content: string
  ): Promise<void> {
    const response = await httpRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        timeoutMs: this.opts.timeoutMs,
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      }
    );

    await assertOk(response, "Discord API", { includeBody: true });
  }

  async fetchMessages(after?: string): Promise<DiscordMessage[]> {
    const { botToken, channelId } = this.opts;
    if (!botToken || !channelId) {
      throw new Error(
        "fetchMessages requires botToken and channelId"
      );
    }

    const params = new URLSearchParams({ limit: "100" });
    if (after) {
      params.set("after", after);
    }

    const response = await httpRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages?${params.toString()}`,
      {
        timeoutMs: this.opts.timeoutMs,
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      }
    );

    await assertOk(response, "Discord API", { includeBody: true });

    return response.json() as Promise<DiscordMessage[]>;
  }
}
