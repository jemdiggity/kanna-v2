# Account email delivery

Kanna keeps Firebase Auth's native verification, password-reset, and email-change flows and uses Firebase's Google-managed custom-domain sender. Staging sends as `Kanna <accounts@auth-staging.kanna.build>`; production will use `Kanna <accounts@auth.kanna.build>` only after an explicitly named human requests the production change.

This decision was made after the stock `noreply@kanna-staging.firebaseapp.com` verification message silently failed to reach a Microsoft 365 mailbox on 2026-08-22.

## Decision

| Option | Strict-host delivery and alignment | Operations and cost around 10k users | Future product email | Decision |
|---|---|---|---|---|
| Google-managed Auth mail on a verified custom domain | Google supplies SPF and DKIM records; aligned DKIM lets DMARC pass. Delivery remains on Google's shared infrastructure, but removes the unbranded `firebaseapp.com` identity and gives the domain an enforceable DMARC policy. | No separate vendor, API key, function, or per-message bill. Identity Platform's email tier is free through 50,000 MAU and a billing-enabled project has much higher Auth-email quotas. | Auth templates only. It cannot send arbitrary lifecycle mail; Stripe remains the sender for receipts. | **Chosen now:** least surface and preserves the client SDK flow. Revisit when Kanna has a concrete non-Auth transactional-email requirement. |
| Identity Platform custom SMTP through Postmark, SES, SendGrid, or Resend | Best provider-level delivery telemetry, suppression management, and reputation controls. SPF/DKIM/DMARC can align on a dedicated subdomain. | Requires upgrading the current `FIREBASE_AUTH` project to Identity Platform, provisioning and paying a provider, rotating an SMTP credential, and monitoring bounces. At 10,000 messages/month, indicative prices are Postmark $15/month, Resend $20/month (50k included), SendGrid $19.95/month (50k), or SES about $1 plus data. Identity Platform itself is $0 through 50k tier-1 MAU. | Strongest extension path: the same provider/domain can serve future product mail, preferably in separate transactional streams. | Preferred migration when arbitrary product mail is actually required, but unnecessary recurring operations today. |
| Custom action links plus a Cloud Function/provider API | Same provider benefits as custom SMTP, with complete content and event control. | Highest burden: callable authorization, abuse controls, templates, localization, retries, idempotency, bounce/suppression handling, secrets, and function/provider billing. | Maximum control and reuse. | Rejected: it changes every portal/mobile caller and duplicates Firebase's mature OOB-code delivery path without a present requirement. |

The current staging project is billing-enabled but reports config subtype `FIREBASE_AUTH`, not `IDENTITY_PLATFORM`. The supported custom-SMTP surface is `notification.sendEmail.method=CUSTOM_SMTP` in the Identity Platform Admin API. Upgrading is irreversible operational scope and is not needed for Google-managed custom-domain delivery. If Kanna later adopts SMTP, keep the provider credential in Google Secret Manager and have the authorized configuration operation read it at execution time; never place it in the repository or shell history.

Primary references:

- [Firebase custom domains for Authentication email](https://firebase.google.com/docs/auth/email-custom-domain)
- [Identity Platform email/SMTP configuration API](https://cloud.google.com/identity-platform/docs/reference/rest/v2/Config)
- [Identity Platform quotas](https://cloud.google.com/identity-platform/quotas)
- [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- [Firebase Admin custom action links](https://firebase.google.com/docs/auth/admin/email-action-links)
- Provider price references: [Postmark](https://postmarkapp.com/pricing/), [SES](https://aws.amazon.com/ses/pricing/), [SendGrid](https://sendgrid.com/content/dam/sendgrid/global/en/other/sendgrid-pricing/twi121--sendgrid-pricing-pdf-st1.pdf), [Resend](https://resend.com/docs/knowledge-base/what-is-resend-pricing)

## Staging state and owner DNS action

On 2026-08-22 the Identity Toolkit Admin API was used to:

1. start custom-domain verification for `auth-staging.kanna.build` in `kanna-staging`;
2. set the verification, reset-password, and change-email templates to sender local-part `accounts`, display name `Kanna`, and reply-to `support@tampopomyoko.com`.

The project now reports `customDomain: auth-staging.kanna.build`, `useCustomDomain: true`, and `method: DEFAULT`. `kanna.build` DNS is hosted at GoDaddy (`ns51.domaincontrol.com` / `ns52.domaincontrol.com`).

These are the records applied in the `kanna.build` GoDaddy DNS zone. GoDaddy record names are relative to `kanna.build`; do not append the zone twice.

| Type | GoDaddy Name | Value | TTL |
|---|---|---|---|
| TXT | `auth-staging` | `firebase=kanna-staging` | 1 hour |
| TXT | `auth-staging` | `v=spf1 include:_spf.firebasemail.com ~all` | 1 hour |
| CNAME | `firebase1._domainkey.auth-staging` | `mail-auth--staging-kanna-build.dkim1._domainkey.firebasemail.com` | 1 hour |
| CNAME | `firebase2._domainkey.auth-staging` | `mail-auth--staging-kanna-build.dkim2._domainkey.firebasemail.com` | 1 hour |
| TXT | `_dmarc.auth-staging` | `v=DMARC1; p=quarantine; adkim=s; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | 1 hour |

Firebase's DKIM target derivation replaces each dot with one hyphen **and doubles every hyphen already present in the domain**. Thus `auth-staging.kanna.build` becomes `auth--staging-kanna-build`, not `auth-staging-kanna-build`. This rule is visible in the Firebase Console instructions dialog but is not stated in the public custom-domain guide. Always copy the console-issued targets; do not derive them by replacing dots alone.

The owner added the records on 2026-08-22. The initial single-dash DKIM targets returned `DKIM_MISMATCH`; after correction to the double-dash targets above, verification succeeded and the manager applied the domain. Live readback then confirmed the applied state described above. Both authoritative GoDaddy nameservers and public resolvers return the corrected targets.

The dedicated subdomain intentionally leaves the apex `kanna.build` SPF record (`include:icloud.com`) untouched; publishing a second SPF record at one name would invalidate SPF. The explicit subdomain DMARC policy makes the intended alignment observable and does not weaken the apex policy.

After DNS propagates, verify it without exposing credentials:

```sh
dig +short TXT auth-staging.kanna.build
dig +short CNAME firebase1._domainkey.auth-staging.kanna.build
dig +short CNAME firebase2._domainkey.auth-staging.kanna.build
dig +short TXT _dmarc.auth-staging.kanna.build
```

Then apply the verified domain (staging only):

```sh
TOKEN="$(gcloud auth print-access-token)"
curl --fail-with-body --silent --show-error -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'X-Goog-User-Project: kanna-staging' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"auth-staging.kanna.build","action":"VERIFY"}' \
  'https://identitytoolkit.googleapis.com/admin/v2/projects/kanna-staging/domain:verify'
curl --fail-with-body --silent --show-error -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'X-Goog-User-Project: kanna-staging' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"auth-staging.kanna.build","action":"APPLY"}' \
  'https://identitytoolkit.googleapis.com/admin/v2/projects/kanna-staging/domain:verify'
unset TOKEN
```

Do not apply while `VERIFY` returns anything other than `VERIFIED`. Confirm the resulting project configuration still says `method: DEFAULT`, says `customDomain: auth-staging.kanna.build`, and has `useCustomDomain: true`.

## Manual delivery gate and staging result

Real delivery is a release gate, not a unit test. Use fresh or disposable staging users so an existing `emailVerified` claim does not suppress the message.

1. Register one `@tampopomyoko.com` (Microsoft 365) address and one Gmail address through the staging portal. This exercises the unchanged client-side `sendEmailVerification` call.
2. Record whether each message arrives in Inbox, Junk/Spam, quarantine, or not at all. Gmail Inbox placement is required. For Microsoft 365, authenticated delivery to Junk is acceptable for initial staging rollout but starts the reputation remedy below; silent drop is a failure. Do not record recipient-local identifiers beyond the addresses the owner authorizes for the test.
3. Where available, open the original message headers and record the `Authentication-Results` verdicts and aligned domains. The target is `spf=pass`, `dkim=pass` with a signing domain aligned to `auth-staging.kanna.build`, and `dmarc=pass` for `auth-staging.kanna.build`. If headers are not captured, say so rather than inferring their exact contents.
4. Open both links and confirm the users become email-verified in the portal.
5. Trigger password reset for both recipients and confirm delivery. Exercise the email-change template with a disposable staging user; because this changes identity state, do not use an owner's primary account.
6. If Microsoft 365 does not deliver at all, inspect Exchange quarantine/message trace before changing architecture. A provider migration is justified only with evidence that the authenticated Google-managed sender is still rejected.

The owner ran the staging gate on 2026-08-22 with fresh portal signups:

- Gmail: delivered to **Inbox** (pass).
- Microsoft 365 at `tampopomyoko.com`: delivered to **Junk**. The message arrived and was reported authenticated, a strict improvement over the pre-change silent drop, but Inbox placement did not pass.
- Raw message headers, message IDs, and exact `Authentication-Results` fields were not captured. No header-level SPF/DKIM/DMARC claim is made beyond the owner's authenticated-delivery report and the independently verified DNS/Firebase configuration.

The M365 Junk result is treated as new-domain reputation, not a configuration defect, and does not justify another architecture change now. Remedy it on two tracks:

1. **Owner's Microsoft 365 tenant:** add `auth-staging.kanna.build` to the Exchange anti-spam allowed sender domains. If a narrowly scoped mail-flow rule is preferred, set SCL to `-1` only for authenticated mail from this sender domain; do not broadly bypass spam filtering for unauthenticated lookalikes.
2. **Third-party tenants:** allow reputation to build through normal authenticated transactional volume and monitor support reports. If Junk placement persists at meaningful scale, migrate Firebase Auth to the documented Postmark or equivalent transactional-provider path for delivery telemetry and reputation operations.

## Production runbook — named human request required

Do not execute any step below merely because staging passed. Production auth and DNS changes require a named human request that explicitly names `kanna-build` and `auth.kanna.build`.

1. Capture the request and verify the effective target is `kanna-build`; read its current Admin API configuration and save a redacted before-state containing subtype, email method, templates, and `dnsInfo`.
2. Start verification for `auth.kanna.build` with `POST /admin/v2/projects/kanna-build/domain:verify`, action `VERIFY`. Do not reuse the staging subdomain.
3. Add the corresponding GoDaddy records, substituting `auth` for `auth-staging`, `firebase=kanna-build` for the ownership TXT value, and `mail-auth-kanna-build` in both DKIM targets. Firebase doubles pre-existing hyphens when forming DKIM targets and uses single hyphens for dots; always copy the console-issued values. `auth.kanna.build` contains no hyphen, so its literal `mail-auth-kanna-build` targets are unaffected. Publish an explicit `_dmarc.auth` policy. Do not edit the apex SPF record.
4. Set all three production template sender local-parts to `accounts`, sender display names to `Kanna`, and reply-to values to `support@tampopomyoko.com`. Preserve the existing production subjects/bodies unless the human request explicitly changes copy.
5. Wait for public DNS, call `VERIFY`, require `VERIFIED`, then call `APPLY`. Read back `customDomain: auth.kanna.build`, `useCustomDomain: true`, and `method: DEFAULT`.
6. Run the M365/Gmail manual delivery gate above against production test users and retain only the minimum header evidence needed to prove SPF/DKIM/DMARC results.
7. Roll back by calling the domain endpoint with action `CANCEL` if verification has not been applied. After application, restore the captured sender/template configuration through the Admin API and select the default sender in the Firebase console; verify readback and send another test. Never improvise a production rollback from staging values.
