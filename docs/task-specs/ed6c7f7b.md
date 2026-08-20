# Task ed6c7f7b — Owner rulings of 2026-08-21: relay-wide entitlement gating and the launch price

Source of terms: two owner rulings delivered with this task's prompt on
2026-08-21, recorded verbatim in `docs/specs/accounts-and-billing.md`:

1. > "Cloud access is paid; connecting to machines the user manually adds with
   > the QR method is free — the user can remotely control them when they're on
   > the same LAN."
2. > "¥500 JPY, $5 USD, $5 CAD, $5 AUD, €5, £5 per month … possibly revised
   > pending our new opex estimation."

Ruling 1 settles the `remote_task_control` decision that task `03389bf0` left
open (its task spec, "Scope — out"): everything that crosses the relay is
entitlement-gated, phone→desktop `invoke` included. LAN paths are untouched and
free forever.

## Goal

Extend the flag-gated relay entitlement enforcement landed by `03389bf0` to the
`invoke` / `remote_task_control` path, record both rulings in the billing spec,
and put the new price where the portal reads it.

## Scope — in

1. **Relay enforcement of `remote_task_control`**, behind the same
   `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT` flag, with the same 4402 refusal
   semantics and the same TTL cache:
   - a phone `invoke` frame from an unentitled session is refused with
     `error: "entitlement required"`, `code: 4402`, and never reaches the
     router;
   - a desktop→desktop `invoke` (the `desktopRouting` capability) is refused
     the same way, and `desktopRouting` is no longer advertised in `auth_ok`
     to an unentitled desktop.
2. **Spec**: both rulings verbatim; Decision 5's enumeration of the enforced
   set extended to `invoke`/`remote_task_control` with the note that the
   decision was pending removed; the price matrix with its revision caveat in
   the pricing section; the per-currency Stripe price points (test + live) in
   Slice 0.
3. **Portal price default**: `resolveWebPortalBuildEnvironment` in
   `tools/kd/src/runtime/cloud-deploy.ts` defaults `VITE_KANNA_CLOUD_PRICE` to
   `$5/month` instead of `$10/month`; the subscribe page shows the same default
   plus the full currency matrix. Same default in `.env.example`/`.env.test`.
4. **Coverage**: relay integration cases for the refused invoke (phone and
   desktop→desktop) with the flag on and unchanged behaviour with it off, and a
   web-portal test for the price display.
5. **Two doc lines kept true by the same change**: the `desktopRouting`
   paragraph in `docs/kanna-server-boundary.md` (the server enables its
   cross-machine bridge only when that capability is advertised, which is now
   also the entitlement's), and the "what runs now instead" list in
   `docs/2026-08-21-relay-entitlement-e2e-gap.md`.

## Scope — out (deliberate)

- **Flipping the flag.** It stays off everywhere; Slice 3 turns it on. Nothing
  in this task enables it.
- **Any Stripe object.** The spec lists the price points a human creates in
  Slice 0; no code creates or reads a price id, and `createCheckoutSession`'s
  price wiring is untouched.
- **Currency detection / i18n.** The prompt asked to keep it minimal: the
  portal keeps a single build-time display string and renders the matrix as
  static copy. No locale framework, no geo lookup.
- **Mobile / desktop client rendering of 4402.** Slice 2 and 3 surfaces.
- **LAN.** Untouched, and free forever, per the ruling.

## Flagged, not fixed

The pricing ruling names monthly amounts only, but
`createCheckoutSession` requires a `STRIPE_PRICE_ANNUAL` id beside the monthly
one (`services/firebase-functions/src/billing/config.ts`), and Decision 4 still
describes an annual Apple product. Recorded in the spec's pricing section and
Slice 0 as an open owner item — pricing an annual plan, or dropping it and that
requirement, is not this task's call and no code here touches it.

## Reading of ruling 1 that widens `invoke` past the phone

The prompt names phone→desktop `invoke`. Desktop→desktop `invoke` crosses the
same relay, carries the same `remote_task_control` capability, and would leave
the capability half-enforced on flag day, so it is gated here too and recorded
in Decision 5. This is an explicit reading of "EVERYTHING through the relay is
entitlement-gated", called out so a reviewer can weigh it rather than discover
it. It changes one existing assertion in
`services/relay/test/entitlement.integration.test.ts` (`desktopRouting` was
asserted to survive for an unentitled desktop, because it was outside the
enforced set until this ruling).

## Constraints carried in

- **Flag-off behaviour must be byte-identical to today.** With enforcement off
  no frame is parsed for the gate, no Firestore read happens, and `auth_ok`
  keeps its exact shape — `desktopRouting` included. A test pins it.
- The gate re-checks per frame through `sessionHasCapability`, so revocation
  lands inside the cache TTL rather than at the next reconnect, exactly like
  publication and push.
- The relay never closes an ordinary session over an entitlement (Decision 5);
  a refused `invoke` answers with a `response` frame carrying the 4402 code.

## Done when

- Flag on: an unentitled phone `invoke` and an unentitled desktop→desktop
  `invoke` are refused with `code: 4402`; an entitled one reaches the router
  (proved by the router's own "Desktop offline" answer with no code);
  `desktopRouting` is absent from an unentitled desktop's `auth_ok`.
- Flag off: the same frames route as they do today — the router's own error, no
  `code` field, `desktopRouting` advertised, no `entitlement` block.
- `docs/specs/accounts-and-billing.md` carries both rulings verbatim, the
  extended Decision 5 enumeration, the price matrix with the revision caveat,
  and the Slice-0 price-point list.
- The portal's price default is the new price, covered by a test.
- The relay suite and `pnpm test` pass; `pnpm exec tsc --noEmit` is clean.
