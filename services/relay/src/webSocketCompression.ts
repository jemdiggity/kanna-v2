import type { PerMessageDeflateOptions } from "ws";

/**
 * The relay's `permessage-deflate` configuration.
 *
 * The relay's dominant traffic is base64-PTY-in-JSON terminal frames — highly
 * repetitive text — and GCP bills egress, so compressing the phone-bound
 * stream is the cheapest byte the relay can save. Compression is *negotiated*
 * per connection: a client that sends no `Sec-WebSocket-Extensions` header
 * keeps working exactly as before, uncompressed. Today the desktop
 * (`crates/kanna-server/src/relay.rs`, `tokio-tungstenite` 0.26) is such a
 * client — that crate has no `permessage-deflate` implementation — so this
 * lever applies to the mobile leg, not the desktop one.
 *
 * Everything here is a bound, because the relay runs on a 1 GB e2-micro
 * (`docs/specs/relay-scaling.md`). zlib's own sizing formulas give, per
 * connection that negotiates and actually uses compression in both directions:
 *
 * - deflate (server→client): `(1 << (windowBits + 2)) + (1 << (memLevel + 9))`
 *   = 32 KiB + 64 KiB = 96 KiB
 * - inflate (client→server): `1 << windowBits`, worst case 32 KiB (see
 *   `clientMaxWindowBits` below)
 * - Node stream chunk buffers: `chunkSize` per direction = 32 KiB
 *
 * ≈ **160 KiB per fully bidirectional compressed connection**, and zero for an
 * idle or non-negotiating one — `ws` creates each zlib context lazily on the
 * first compressed message in that direction. At the scaling spec's Stage 2
 * (~160 sockets) that is ~25 MB; at its Stage 3 per-shard target (2,500
 * sockets) it is ~400 MB, which is one of the reasons that stage shards.
 */
export const RELAY_PER_MESSAGE_DEFLATE: PerMessageDeflateOptions = {
  /**
   * 8 KiB LZ77 window for the server→client direction — the memory this lever
   * has to bound, since it is allocated per connection and the server-to-phone
   * direction is the one carrying terminal output. Leaving it at zlib's
   * default 15 would double the window to 128 KiB per connection for a few
   * percent of ratio on frame-sized payloads.
   *
   * Known handshake edge: `ws` aborts an upgrade with HTTP 400 when it cannot
   * accept an offer, and it refuses an offer that asks for a server window
   * *smaller* than this. No client here does that — browsers and okhttp send
   * either nothing or 15, and the desktop sends no extension header at all.
   */
  serverMaxWindowBits: 13,

  /**
   * Deliberately unset. Setting `clientMaxWindowBits` to a number makes `ws`
   * reject — with a 400 — any client that does not advertise that parameter.
   * Bounding the inflate window is worth 32 KiB per connection and is not
   * worth refusing connections for, so the client→server direction keeps
   * zlib's default window.
   */
  clientMaxWindowBits: undefined,

  zlibDeflateOptions: {
    /**
     * zlib's default. The e2-micro has 0.25 sustained vCPU, and compression is
     * the first real CPU cost the relay has ever had: if it shows up in the
     * event-loop budget, lowering this is the knob to turn before touching the
     * window sizes, since level trades ratio for CPU and the windows trade
     * ratio for RAM.
     */
    level: 6,
    /** 64 KiB of deflate hash tables (`1 << (memLevel + 9)`). */
    memLevel: 7,
    chunkSize: 16 * 1024,
  },

  zlibInflateOptions: {
    chunkSize: 16 * 1024,
  },

  /**
   * Concurrent zlib operations across the whole process. This bounds how much
   * compression work is in flight at once — it does not bound how many
   * contexts exist, which is the per-connection figure above.
   */
  concurrencyLimit: 10,

  /**
   * Payloads below this skip compression entirely. Keystroke frames (~200 B),
   * acks, and control responses are all smaller than this and gain nothing
   * from a deflate round trip; paying zlib for them would add latency to the
   * interactive path for no byte saving.
   */
  threshold: 1024,
};
