import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { getWebDriverPort } from "../helpers/webdriverPort";

// The renderer fences every transfer lifecycle settlement with the consumer
// incarnation the backend minted for it, so a replaced renderer can never
// acknowledge, NACK, renew, claim a phase on, or release its successor's work.
// Unit tests cover the queue state machine and App.test.ts covers the renderer,
// but both sides mock the boundary between them. These assertions run against
// the packaged app over real Tauri IPC, so they are the only coverage that
// proves the command registration, the camelCase argument binding, and the
// serialized claim shape actually agree across the process boundary.

interface ConsumerClaim {
  authoritative?: boolean;
  consumerIncarnation?: string;
  __error?: string;
}

interface InvokeError {
  __error?: string;
}

const UNKNOWN_DELIVERY_ID = "e2e-unknown-lifecycle-delivery";
const SETTLEMENT_COMMANDS = [
  "acknowledge_transfer_lifecycle_event",
  "nack_transfer_lifecycle_event",
  "renew_transfer_lifecycle_event",
] as const;

const client = new WebDriverClient(getWebDriverPort());

async function claimConsumer(): Promise<ConsumerClaim> {
  return await tauriInvoke(client, "claim_transfer_event_consumer") as ConsumerClaim;
}

function incarnationOf(claim: ConsumerClaim): string {
  expect(claim.__error).toBeUndefined();
  expect(claim.consumerIncarnation).toBeTypeOf("string");
  return claim.consumerIncarnation as string;
}

describe("transfer lifecycle consumer incarnations", () => {
  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    // The consumer is app-global state shared by every mock e2e target, and
    // these assertions deliberately supersede and release the app's own claim.
    // Leave a live claim behind so the instance is handed on as it was found.
    await claimConsumer();
    await client.deleteSession();
  });

  it("mints a fresh unguessable incarnation for every claim", async () => {
    const first = await claimConsumer();
    expect(first.authoritative).toBe(true);
    const firstIncarnation = incarnationOf(first);
    // 32 random bytes, base64url without padding.
    expect(firstIncarnation).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = await claimConsumer();
    expect(second.authoritative).toBe(true);
    expect(incarnationOf(second)).not.toBe(firstIncarnation);
  });

  it("refuses lifecycle settlement and release from a superseded incarnation", async () => {
    const superseded = incarnationOf(await claimConsumer());
    const live = incarnationOf(await claimConsumer());

    // Neither incarnation owns this delivery id, so both settlement attempts
    // report "not mine". What this proves is that the arguments bind and the
    // commands answer at all — the incarnation split is asserted below, where
    // the two answers genuinely differ.
    for (const command of SETTLEMENT_COMMANDS) {
      expect(await tauriInvoke(client, command, {
        deliveryId: UNKNOWN_DELIVERY_ID,
        consumerIncarnation: superseded,
      })).toBe(false);
      expect(await tauriInvoke(client, command, {
        deliveryId: UNKNOWN_DELIVERY_ID,
        consumerIncarnation: live,
      })).toBe(false);
    }

    // Phase claims distinguish the two failures: a superseded incarnation is
    // rejected as a non-owner before the queue is ever consulted, while the
    // live one gets far enough to report the delivery itself is unknown.
    const supersededPhase = await tauriInvoke(client, "claim_transfer_lifecycle_phase", {
      deliveryId: UNKNOWN_DELIVERY_ID,
      consumerIncarnation: superseded,
      phase: "pty-finalization-signal",
    }) as InvokeError;
    expect(supersededPhase.__error).toContain("no longer owned");

    const livePhase = await tauriInvoke(client, "claim_transfer_lifecycle_phase", {
      deliveryId: UNKNOWN_DELIVERY_ID,
      consumerIncarnation: live,
      phase: "pty-finalization-signal",
    }) as InvokeError;
    expect(livePhase.__error).toContain("unknown transfer lifecycle delivery");

    // A superseded renderer unmounting late must not tear down its successor.
    expect(await tauriInvoke(client, "release_transfer_event_consumer", {
      consumerIncarnation: superseded,
    })).toBe(false);
    expect(await tauriInvoke(client, "release_transfer_event_consumer", {
      consumerIncarnation: live,
    })).toBe(true);
  });

  it("requires an incarnation before staging an artifact against a delivery", async () => {
    const live = incarnationOf(await claimConsumer());

    const withoutIncarnation = await tauriInvoke(client, "stage_transfer_artifact", {
      transferId: "e2e-transfer",
      artifactId: "e2e-artifact",
      path: "/nonexistent/e2e-artifact.bundle",
      owned: true,
      deliveryId: UNKNOWN_DELIVERY_ID,
    }) as InvokeError;
    expect(withoutIncarnation.__error).toContain("missing consumer incarnation");

    const withLiveIncarnation = await tauriInvoke(client, "stage_transfer_artifact", {
      transferId: "e2e-transfer",
      artifactId: "e2e-artifact",
      path: "/nonexistent/e2e-artifact.bundle",
      owned: true,
      deliveryId: UNKNOWN_DELIVERY_ID,
      consumerIncarnation: live,
    }) as InvokeError;
    expect(withLiveIncarnation.__error).toContain("no longer owned");
  });
});
