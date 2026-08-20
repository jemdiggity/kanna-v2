# Relay entitlement enforcement E2E gap — 2026-08-21

Written by the Slice-1 relay task (`03389bf0`), which landed the entitlement
check, the 4402 refusal semantics behind
`KANNA_RELAY_ENTITLEMENT_ENFORCEMENT` (off everywhere), and the comp seeding
script. Companion to `docs/2026-08-20-billing-e2e-gap.md`, which covers the
Stripe half.

## What cannot be tested end to end, and why

`docs/specs/accounts-and-billing.md` Decision 8 asks for a staging-stack flow:
create an account → Stripe test-mode checkout → webhook → entitlement doc →
**relay session gains tunnel service**, and the reverse — subscription canceled
→ relay refuses with 4402 → **mobile shows the neutral state**. Neither end of
that sentence exists yet:

- **The paying half is blocked on Slice 0.** No Stripe account, no test keys,
  no deployed `stripeWebhook` endpoint — the same blocker the billing note
  enumerates. Without it nothing can drive a real entitlement transition on a
  staging stack.
- **The rendering half has no surface.** No client reads the `entitlement`
  block or the 4402 code yet: the portal and the mobile subscribe screen are
  Slice 2, and the desktop entitlement surface is Slice 3. There is nothing to
  assert a neutral state against.
- **Enforcement is off by design.** The flag stays off until the Slice-3 flag
  day, so no deployed relay exercises this path at all. An E2E against staging
  today would assert the *absence* of enforcement, which is what the existing
  relay suite already covers.

## What runs now instead

`services/relay/test/entitlement.integration.test.ts` — two real relay
processes against one Firebase emulator, one with the flag on and one with it
off, speaking the real protocol:

- an entitled desktop is advertised `tunnelServices` plus the publication and
  notification capabilities, and publishes;
- an unentitled desktop still authenticates, is advertised none of them, and is
  refused publication and push with `code: 4402`;
- an unentitled phone's `tunnel_request` is refused with the same code, while an
  entitled one reaches the router;
- an unentitled `invoke` is refused with the same code — phone→desktop and
  desktop→desktop alike, and `desktopRouting` is not advertised to an
  unentitled desktop — while an entitled one reaches the router, and with the
  flag off both route exactly as they do today (added 2026-08-21 by task
  `ed6c7f7b`, on the owner ruling that everything crossing the relay is paid);
- an unentitled desktop opening a tunnel socket directly — no phone involved —
  is closed with 4402 at the handshake, and the same connection against the
  flag-off relay gets past it to the router's own 4404;
- an unverified phone token is refused even holding an active subscription;
- a `grace` record whose `graceEndsAt` has passed is refused — nothing sweeps
  it, so the enforcement-side read is what expires it;
- a revocation on a live session is honoured within the cache TTL, without a
  reconnect;
- with the flag off, the same unentitled account gets the full capability set,
  no `entitlement` field at all, and a successful publication.

The comp path is proved end to end within that suite: it runs the real
`comp:grant` script against the emulator, which writes `billing/comp`, invokes
`recomputeEntitlement`, and the relay then serves the account.
`services/firebase-functions/test/comp-grant.test.ts` covers the grant/revoke
matrix, including that a source-doc write with no recompute grants nothing, and
`comp-grant-script.test.ts` runs the script as a process — grant, revoke,
`--dry-run`, and the guards that keep a dev shell from writing a grant into a
real project.

`services/relay/test/entitlement.test.ts` covers the flag vocabulary, the cache
(TTL bound both ways, no caching of failures, capacity) and the fail-open
posture.

## What would close the gap

1. Slice 0's Stripe account and test keys, plus the deployed staging functions
   (the billing note's step 2).
2. Slice 2's portal and mobile subscribe/status screens — the surfaces that
   render the neutral inactive state.
3. A staging E2E that flips `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT=on` on the
   staging relay, drives a test-mode subscription and cancellation, and asserts
   the relay's advertised capabilities on both sides of each transition. That is
   Slice 3 work: turning the flag on in staging is itself the flag-day rehearsal.
