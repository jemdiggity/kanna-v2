# Remote Companion Demand and Event Epochs Design

## Goal

Close the remaining remote visual companion resource and attachment races:

- assetless-only subscriptions must not read, hash, encode, or retain companion
  assets;
- one full bundle must remain shared whenever at least one observer requests
  assets; and
- companion selections and their results must not cross attachment
  generations.

## Asset demand architecture

`CompanionResources` continues to own one `CompanionScanSource` per database
and task. Each subscription declares whether it needs assets. The source tracks
the number of asset-requiring subscribers and wakes its scanner when demand
changes between zero and nonzero.

The visual-companion scanner accepts an asset-materialization choice. Its
cache identity includes that choice so the same metadata fingerprint is
rematerialized when demand changes. Assetless scans still enumerate and
fingerprint descriptor metadata so asset changes update the companion
revision, but they do not open asset payloads, read bytes, calculate payload
digests, or base64-encode data. Their materialization-budget reservation also
excludes the maximum asset payload allowance.

The scan source rechecks demand after a blocking scan. If demand changed while
the scan was running, the result is discarded and the scanner is invalidated
before retrying. This prevents an assetless result from reaching a newly
assetful observer and prevents a completed full bundle from being retained
after the last assetful observer leaves.

The retained frame records whether it contains requested assets. When any
observer needs assets, all observers share that single retained full frame;
per-attachment delivery still strips assets for observers that requested
`include_assets=false`. When demand returns to zero, the source replaces the
full retained frame with an assetless frame, releasing the asset bytes from the
global retained pool.

## Attachment-bound companion events

`ClientFrame::CompanionEvent` and `ServerFrame::CompanionEventResult` gain an
optional `attachment_epoch`. Optional fields retain wire compatibility with
older peers.

The stream client sends the current companion attachment generation on every
selection and stores that generation with the pending request. The server
accepts a selection only when its epoch exactly matches the current companion
attachment, including `None` matching `None` for legacy clients. The epoch is
copied into the queued append request and every success or failure result.

On receipt, the stream client requires a pending request with the same task,
event id, attachment generation, and compatible result epoch. It also requires
that generation to remain the current attachment. Results without a matching
pending request, or results from superseded attachments, are discarded.
Crucially, an old result with a reused event id does not remove the newer
generation's pending request.

## Error and compatibility behavior

- A selection without a matching current attachment receives a rejected
  attachment-stale result bound to the submitted epoch.
- Current peers require safe integer epochs that match their attachment.
- Legacy peers without the attachment-epoch capability may exchange omitted
  event epochs, but results still require a current locally pending request.
- Existing revision/session validation and durable event idempotency remain
  unchanged.

## Verification

Tests will prove:

1. an assetless scanner skips optional asset materialization and caches the
   result;
2. several maximum legal assetless bundles remain admitted simultaneously
   without retaining asset bytes or exhausting the global pool;
3. mixed subscribers share one source, upgrade it to a full bundle while
   assets are demanded, and downgrade after demand disappears;
4. protocol frames round-trip optional selection epochs while legacy frames
   still deserialize;
5. the server binds all event-result paths to the submitted/current epoch; and
6. a result delayed across blocked append or acknowledgement, detach, and
   reattach cannot reach the replacement attachment or consume its pending
   event.
