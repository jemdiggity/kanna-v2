# Auth email deliverability E2E gap (2026-08-22)

Firebase Auth account-email delivery crosses the portal, Google's Auth mailer, public DNS, receiving MTAs, tenant policy, and a human-controlled inbox. CI cannot prove inbox placement or inspect Microsoft 365/Gmail message headers without durable mailbox credentials, and committing or provisioning such credentials would create a larger security problem than the test solves.

The portal's existing emulator integration tests cover registration and the client-side verification request. The external configuration is verified by reading back Identity Toolkit's `notification.sendEmail` state and querying public DNS. The owner ran the manual delivery gate on 2026-08-22: Gmail reached Inbox, while the authenticated Microsoft 365 message reached Junk rather than being silently dropped. Raw headers and action-link redemption evidence were not captured, so those remain explicit evidence gaps rather than inferred passes.

This gap can close when the project owns isolated M365 and Gmail test tenants with secrets stored outside the repository, provider-supported message trace APIs, and a CI policy that safely handles message bodies and one-time action links. Until then, each production change still requires a human to record placement and whatever header/action evidence was actually collected; missing evidence must stay visible.
