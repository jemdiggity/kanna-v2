# Kanna Mobile Privacy Policy

Effective date: August 9, 2026

Technical implementation reviewed: August 9, 2026

Kanna Mobile is operated by Tampopo LLC ("Kanna," "we," "us," or "our"). This policy explains how Kanna Mobile handles information when you use the mobile app with the Kanna desktop app for macOS.

## The most important point for developers

Kanna controls coding-agent tasks. When you use cloud access, **task prompts, commands and terminal or agent output travel through Kanna's relay infrastructure between your mobile device and your Mac. This content may contain source code, file contents, diffs, credentials, secrets, personal information, or other confidential material.** A task created remotely sends its full prompt through the relay. Terminal input and output and other content you choose to open remotely also pass through the relay.

Kanna also stores a cloud task index in Google Firestore. That index includes the task title, the first 500 characters of the task prompt, and up to 240 characters of a waiting/output preview, together with the task and repository metadata described below. Do not put information in a prompt, terminal session, repository name, branch name, remote URL, or other task field unless you are comfortable with it being handled in this way.

When Kanna Mobile connects directly to your Mac over your local network, the mobile requests and live task traffic on that direct connection stay on that network and do not pass through Kanna's Firebase or relay services. If cloud features are separately enabled on the desktop, the desktop may still publish its cloud task index independently of the mobile app's direct LAN connection.

Source: [desktop cloud task publisher](https://github.com/tampopogk/kanna/blob/main/crates/kanna-server/src/cloud_task_publisher.rs), [mobile relay client](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/transports/relayClient.ts), [relay router](https://github.com/tampopogk/kanna/blob/main/services/relay/src/router.ts), and [LAN transport](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/transports/lanTransport.ts).

## Information Kanna handles

### Account and authentication information

Kanna Mobile supports email-and-password sign-in through Google Firebase Authentication. Firebase receives the email address and password used to sign in. The app receives and uses the resulting Firebase user ID, email address, optional display name, and Firebase ID tokens. It stores Firebase authentication session data in the device's AsyncStorage with keys beginning `firebaseAuth:` so that a session can persist between launches.

Source: [Firebase authentication adapter](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/sdk.ts), [authentication model](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/auth.ts), and [authentication persistence](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/authPersistence.ts).

### Desktop, repository, and task information stored in the cloud

An authenticated Kanna desktop publishes an account-scoped index under `users/{uid}/desktops/{desktopDocId}/tasks` in Firestore. Depending on what is present in a task, this can include:

- desktop ID and display name;
- task IDs, title or display name, the first 500 characters of the prompt, and up to 240 characters of a waiting/output preview;
- stage, status, activity, task relationships and blockers, and creation and update timestamps;
- repository ID, repository name, remote URL and its hash, and default branch;
- task branch, base reference, pull request number and URL;
- agent provider and execution type; and
- task-transfer state and identifiers, and desktop transfer identity information such as a peer ID and public key.

The mobile app reads this index only within the signed-in user's account. Firestore client rules deny mobile clients access to another user's task index and deny client-side writes to the index; the authenticated relay service performs publication.

Source: [desktop cloud task publisher](https://github.com/tampopogk/kanna/blob/main/crates/kanna-server/src/cloud_task_publisher.rs), [relay cloud publication](https://github.com/tampopogk/kanna/blob/main/services/relay/src/cloudTaskPublication.ts), [mobile task index](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/taskIndex.ts), and [Firestore rules](https://github.com/tampopogk/kanna/blob/main/firestore.rules).

### Content sent through cloud access

Firebase ID tokens authenticate Kanna Mobile's encrypted WebSocket connection to `relay.kanna.build`. The relay routes requests and live streams to and from the selected desktop. The routed content can include full task prompts, text sent to an agent, a photo you attach to a message, terminal keystrokes and output, agent events and permission decisions, task details, repository commands, task file and diff content requested in the app, and visual-companion content and interactions.

The relay implementation routes live connection data in memory and the source does not implement a database for storing full relay message bodies or terminal streams. This does not change the separate Firestore task-index storage described above, and operational infrastructure may generate logs as described below.

Source: [mobile environment configuration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/mobileEnvironments.json), [mobile relay client](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/transports/relayClient.ts), [remote transport](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/transports/remoteTransport.ts), [relay router](https://github.com/tampopogk/kanna/blob/main/services/relay/src/router.ts), and [relay server](https://github.com/tampopogk/kanna/blob/main/services/relay/src/index.ts).

### Photos you attach to an agent message

You can attach one photo to a message you send to an agent, from your photo library or by taking one. Photo-library permission is optional and is requested only when you use that control; without it the composer still sends text.

The app resizes the photo and re-encodes it as a JPEG on the device before it is sent, and sends it with your message to the Mac that owns the task — directly over your local network, or through the relay when you are away from it, the same way your message text travels. The relay routes it and the source does not implement storage for it. The Mac writes the photo into a per-task attachment folder beside its own database, tells the agent where that file is, and deletes the folder when the task is closed. Kanna does not upload your photo anywhere else and does not store it in the cloud task index.

Source: [photo picking and downscaling](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/attachments/pickImageAttachment.ts), [attachment size budget](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/attachments/imageAttachmentBudget.ts), and [desktop attachment storage](https://github.com/tampopogk/kanna/blob/main/crates/kanna-server/src/task_input_attachments.rs).

### Local pairing and device information

For direct LAN use, Kanna Mobile discovers Kanna desktops on the local network and sends a one-time pairing code, a generated mobile device ID, and a device name to the selected Mac. The Mac returns a device secret. The app stores the desktop ID and name, local endpoint, last-seen time, mobile device ID, and device secret locally and presents the device ID and secret with later LAN requests. Firebase identity is not used to authenticate this direct LAN path.

Direct LAN requests currently use local HTTP and WebSocket connections. They are authenticated with the paired device credentials but are not represented by the source as end-to-end encrypted application traffic. Use LAN pairing only on a network you trust.

Source: [machine pairing](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/pairing/machinePairing.ts), [LAN transport](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/transports/lanTransport.ts), [local session persistence](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/state/sessionPersistence.ts), and [server LAN trust checks](https://github.com/tampopogk/kanna/blob/main/crates/kanna-server/src/http_api/lan_trust.rs).

### Information stored only on the mobile device

Kanna Mobile uses AsyncStorage for local settings and continuity. The local session context under `kanna.mobile.context.v1` can contain the selected desktop, repository, task and screen, basic signed-in user details, trusted desktop endpoints and pairing secrets, agent preferences, and an unfinished task-creation attempt including its prompt. Custom quick replies are stored under `kanna.mobile.quick-replies.v1`.

Crash diagnostics are stored only on the device under `kanna.mobile.crash-diagnostics.v1`. Kanna keeps at most five of these records. They can contain an error message and stack, build information, selected task ID, connection and terminal state, and recent diagnostic breadcrumbs; fields whose names look like tokens, passwords, secrets, credentials, cookies, or session values are redacted. **Kanna does not automatically transmit these crash diagnostics.** They leave the app only if you deliberately copy and share them. The app provides controls to copy or clear them.

Source: [session persistence](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/state/sessionPersistence.ts), [persisted session projection](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/state/sessionStore.ts), [quick-reply persistence](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/state/taskQuickReplyPreferences.ts), [crash diagnostics](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/diagnostics/mobileCrashDiagnostics.ts), and [diagnostic controls](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/BuildInfoPanel.tsx).

### Push notifications

If you allow notifications, the app obtains a Firebase Cloud Messaging (FCM) device token and sends it to the Kanna relay with the mobile device ID and a Firebase ID token. Kanna stores the device ID and FCM token under the signed-in user's Firestore record. A notification can include a title and body plus a desktop ID and task ID. Google Firebase Cloud Messaging and Apple's push-notification service process this information to deliver the notification.

Source: [mobile push registration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/notifications/mobilePush.ts), [relay push registration](https://github.com/tampopogk/kanna/blob/main/services/relay/src/auth.ts), and [notification delivery](https://github.com/tampopogk/kanna/blob/main/services/relay/src/mobileNotifications.ts).

### Camera

Camera permission is optional. Kanna uses it to scan a machine-pairing QR code, and — if you choose to take a photo rather than pick one — to capture a photo you attach to an agent message. When scanning a pairing code the app processes the scanned QR value as a pairing payload and the source does not save or upload the camera image or video. A photo you deliberately take for an attachment is handled as described under "Photos you attach to an agent message". You can enter the six-character pairing code instead of granting camera access.

Source: [pairing camera UI](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/MachinePairingSheet.tsx) and [camera configuration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/app.config.ts).

### Connection and operational logs

The relay logs connection and service events. These logs can include an IP address, Firebase user ID, connection role (mobile or desktop), desktop ID, connection and close status, error messages, and push-registration device IDs. OTA update requests and other infrastructure requests can also expose an IP address and request metadata to the serving infrastructure. The OTA manifest request includes items such as the platform, runtime version, release channel, and current update ID when present.

Source: [relay server logging](https://github.com/tampopogk/kanna/blob/main/services/relay/src/index.ts), [relay connection logging](https://github.com/tampopogk/kanna/blob/main/services/relay/src/router.ts), [push registration logging](https://github.com/tampopogk/kanna/blob/main/services/relay/src/auth.ts), and [OTA request handling](https://github.com/tampopogk/kanna/blob/main/services/relay/src/ota.ts).

## Why Kanna handles this information

Kanna uses the information above to:

- authenticate you and maintain your signed-in session;
- pair the mobile app with a trusted Mac;
- show desktops, repositories, and task status;
- create and control tasks and carry live terminal, agent, file, diff, and companion traffic;
- deliver notifications you enable;
- protect account-scoped connections and diagnose service failures; and
- check for and deliver signed mobile JavaScript and asset updates from `https://relay.kanna.build/ota/manifest`.

Source: [mobile OTA specification](https://github.com/tampopogk/kanna/blob/main/docs/specs/mobile-ota-updates.md) and the implementation sources cited above.

## Service providers and disclosures

Kanna's implementation uses the following service providers and platforms:

- **Google Firebase Authentication** for account sign-in and identity tokens;
- **Google Cloud Firestore** for account, desktop, cloud task-index, credential, and push-registration records;
- **Google Firebase Cloud Messaging** and **Apple Push Notification service** for optional push delivery; and
- **Google Cloud infrastructure**, including a Google Cloud-hosted relay and Cloud Storage for over-the-air app updates.

These providers process information to provide their services to Kanna. Kanna may also disclose information where required by applicable law, regulation, legal process, or an enforceable governmental request, or where we reasonably believe disclosure is necessary to investigate or prevent fraud, to enforce our terms, or to protect the rights, safety, or property of Kanna, our users, or the public. If Kanna is involved in a merger, acquisition, or sale of assets, information may transfer as part of that transaction, and we will make reasonable efforts to notify affected users.

The mobile source contains no advertising SDK, imports no Firebase Analytics module, and the production Firebase configuration sets `IS_ANALYTICS_ENABLED` to false. The source contains no mechanism for cross-app advertising tracking.

We do not sell personal information, and we do not share it with third parties for cross-context behavioral advertising. We disclose information only to the service providers that operate Kanna and in the circumstances described in this policy.

Source: [production Firebase configuration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/firebase/GoogleService-Info.production.plist), [mobile package manifest](https://github.com/tampopogk/kanna/blob/main/apps/mobile/package.json), [Firebase service initialization](https://github.com/tampopogk/kanna/blob/main/services/relay/src/firebase.ts), and [relay operations](https://github.com/tampopogk/kanna/blob/main/docs/relay-vm-operations.md).

## Retention

The code establishes the following product behavior but does not establish organization-wide retention periods:

- local crash diagnostics are capped at five records and can be cleared in the app;
- local session, pairing, and preference records remain on the device until replaced, removed through an available app control, or removed with the app's local data;
- push registration is deleted from Firestore when the app successfully unregisters the device, and invalid FCM tokens are removed after delivery failures;
- the desktop's Firestore task collection is reconciled to its current published open-task snapshot, and task documents absent from a later snapshot are deleted; and
- relay connection routing state is held in memory for active connections, while operational logs are handled separately; and
- a photo attached to an agent message is stored by the receiving Mac in that task's attachment folder and deleted when the task is closed.

Beyond that product behavior, we retain information as follows:

- **Firebase Authentication accounts and Firestore records** (account documents, desktop and cloud task index, desktop credential hashes, push registrations) are kept while your account is active, and are deleted within 30 days of a verified deletion request.
- **Relay and infrastructure logs**, which can include IP addresses, are kept for a short operational period for security and troubleshooting and are then discarded on the provider's normal cycle.
- **Support and deletion-request correspondence** is kept only as long as needed to handle the request and to keep a record that we handled it.
- **Backups** are rotated on their own schedule. Deleted records may persist in a backup until that backup ages out, after which they are not restored.

Where a longer period is required to meet a legal obligation, resolve a dispute, or enforce our agreements, we retain the minimum necessary for that purpose.

Source: [crash-diagnostic retention](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/diagnostics/mobileCrashDiagnostics.ts), [push unregistration](https://github.com/tampopogk/kanna/blob/main/services/relay/src/auth.ts), [stale push-token removal](https://github.com/tampopogk/kanna/blob/main/services/relay/src/mobileNotifications.ts), and [cloud task reconciliation](https://github.com/tampopogk/kanna/blob/main/services/relay/src/cloudTaskPublication.ts).

## Deletion requests and choices

Kanna Mobile currently provides sign-out, removal of a manual LAN pairing, and clearing of local crash diagnostics. It does not currently provide an in-app workflow that deletes the Firebase Authentication account and all associated cloud records.

To request deletion of your Kanna account or Kanna-hosted data, email **support@tampopomyoko.com** with the subject "Delete my account". Include the email address associated with the account and identify any desktops whose data you want deleted. Do not send your password, Firebase token, pairing secret, source code, or other credentials.

We verify a request by confirming it comes from the account's own email address; if it arrives from another address, we will write to the account address before acting. A verified deletion covers your Firebase Authentication account, your Firestore account document, your desktop and cloud task index, stored desktop credential hashes, and push-notification registrations. We acknowledge requests promptly, complete verified deletions within 30 days, and email you confirmation when the deletion is done. The backup and legal-retention exceptions described under Retention apply.

Deleting Kanna-hosted data does not by itself delete data stored on your Mac, in local mobile AsyncStorage, in your source-control provider, or by an agent provider you use with Kanna. Remove local pairings and app data on the relevant devices, and contact those other providers as needed.

Source: [current account controls](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/AccountSheet.tsx), [machine removal UI](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/screens/MachinesScreen.tsx), [diagnostic controls](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/BuildInfoPanel.tsx), and [App Store review audit](https://github.com/tampopogk/kanna/blob/main/docs/mobile-app-store-review-audit.md).

## Security

Cloud relay and OTA endpoints use `wss://` and `https://`, and Firebase ID tokens authenticate mobile relay sessions. Desktop cloud publication uses desktop credentials. Direct LAN access uses a per-device ID and secret issued during pairing. No system can guarantee absolute security, and Kanna's direct LAN transport is not represented by the source as end-to-end encrypted; use trusted networks and protect your Kanna account, devices, repositories, and agent-provider credentials.

## Children

Kanna Mobile is a developer tool intended for adults. It is not directed to children, and we do not knowingly collect personal information from children. If you believe a child has provided us with personal information, contact us and we will delete it.

## Policy changes

When this policy changes, we post the updated version at `https://kanna.build/privacy` with a new effective date. For changes that materially affect how we handle your information, we will give notice before the change takes effect, through the app or to the email address associated with your account. Continuing to use Kanna Mobile after a change takes effect means the updated policy applies to you.

## Governing law and privacy rights

Tampopo LLC operates Kanna from Japan, and this policy is governed by the laws of Japan.

Under Japan's Act on the Protection of Personal Information (APPI), you may ask us to disclose the personal information we hold about you, to correct or add to it if it is inaccurate, or to stop using or delete it where the Act provides that right. Email **support@tampopomyoko.com** to make a request. We verify requests as described under Deletion requests and choices, and we respond without undue delay. If you are not satisfied with our response, you may raise the matter with Japan's Personal Information Protection Commission.

Kanna is available to users outside Japan. If the law where you live gives you additional privacy rights, contact us and we will consider your request under that law. Information you send through Kanna is processed on Google Cloud and Firebase infrastructure, which may be located outside your country.

## Contact

Privacy contact: **support@tampopomyoko.com**

Postal address: Tampopo LLC, 1257 Ryozenji, Myoko-shi, Niigata-ken 944-0062, Japan

Support: `https://kanna.build/support`
