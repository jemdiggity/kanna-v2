# Kanna Mobile App Privacy Answer Sheet

Prepared: 2026-08-08

This is a source-derived worksheet for the human completing App Store
Connect's **App Privacy** form for Kanna Mobile. It is not legal advice. Items
marked **Requires human confirmation** must be decided by Kanna's business or
legal owner before the answers are published.

This audit covers the production iOS app with bundle ID `build.kanna.app` and
mobile runtime version `2.1.4`. The runtime version comes from
[`apps/mobile/src/mobileEnvironments.json`](../apps/mobile/src/mobileEnvironments.json),
not the stale `1.0.0` value in the July submission notes.

Apple's current definitions are the controlling definitions:

- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [Manage app privacy in App Store Connect](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [Firebase's Apple data-disclosure guidance](https://firebase.google.com/docs/ios/app-store-data-collection)
- [Firebase privacy and retention information](https://firebase.google.com/support/privacy/)

Apple says to disclose all data collected through any supported app behavior,
even when only some users take that path. Apple also says data is not
"collected" when it is processed only on-device, or when it is transmitted
off-device and discarded immediately after servicing the request. The answers
below apply those definitions to the source as it exists on the preparation
date.

## Form summary

At **App Privacy → Get Started**, answer:

- **Do you or your third-party partners collect data from this app?** **Yes**

Select these data types:

| App Store Connect data type | Select | Linked to identity | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| User Content → Other User Content | Yes | Yes | No | App Functionality |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| Identifiers → Device ID | Yes | Yes | No | App Functionality |
| Diagnostics → Other Diagnostic Data | Yes | Yes | No | App Functionality |
| Other Data → Other Data Types | Yes | Yes | No | App Functionality; Analytics for Firebase's unlinked SDK/platform-adoption metadata |

The `Other Data Types` recommendation is conservative. Firebase Messaging's
documented always-collected data includes device model, language, time zone,
OS version, application identifier, and application version, which do not fit
another App Store Connect data type cleanly. Firebase also records the APNs
token and associates it with a Firebase installation ID/FCM registration
token. Kanna separately stores that FCM token under the signed-in Firebase
UID. See
[`apps/mobile/package.json`](../apps/mobile/package.json),
[`apps/mobile/src/lib/notifications/mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts),
and
[`services/relay/src/auth.ts`](../services/relay/src/auth.ts).

Do not publish the form until the three conditional decisions in
[Requires human confirmation](#requires-human-confirmation) have been made.
They may add **Coarse Location**, **Sensitive Info**, or usage/analytics data
types.

## LAN and WAN must not be conflated

### LAN path

LAN authentication uses only pairing credentials; it does not send a Firebase
UID, email address, or Firebase ID token to the desktop.

1. The camera reads a QR payload containing a desktop ID and six-character
   pairing code. The frame and QR image are processed on-device and are not
   uploaded. The same code can be entered manually. Evidence:
   [`MachinePairingSheet.tsx`](../apps/mobile/src/components/MachinePairingSheet.tsx)
   and
   [`pairingPayload.ts`](../apps/mobile/src/lib/pairing/pairingPayload.ts).
2. The phone sends its Kanna-generated mobile device ID, the fixed name
   `Kanna Mobile`, and the pairing code directly to the discovered desktop's
   LAN address. The desktop returns a device secret. Evidence:
   [`machinePairing.ts`](../apps/mobile/src/lib/pairing/machinePairing.ts) and
   [`pairing.rs`](../crates/kanna-server/src/pairing.rs).
3. Later LAN HTTP and terminal requests present the mobile device ID and device
   secret directly to that desktop. The mobile app stores the plaintext secret
   locally, while the desktop stores only its hash. Evidence:
   [`lanTransport.ts`](../apps/mobile/src/lib/transports/lanTransport.ts),
   [`sessionPersistence.ts`](../apps/mobile/src/state/sessionPersistence.ts),
   [`lan_trust.rs`](../crates/kanna-server/src/http_api/lan_trust.rs), and
   [`ksp.rs`](../crates/kanna-server/src/ksp.rs).

Task prompts, task input, terminal output, and task metadata used over this
path travel directly between the user's phone and paired desktop on the local
network. They are not sent to Firebase or the Kanna relay merely because the
LAN transport is used.

If LAN were the app's only behavior, the pairing credentials, QR camera input,
and task content above would not be Kanna cloud collection. They remain on the
user's devices and local network.

### WAN/relay path

The WAN path is account-linked and is the reason the form must say that Kanna
collects data:

1. Email/password sign-in uses Firebase Authentication. Firebase supplies a
   UID, email, and optional display name, and the phone obtains a Firebase ID
   token. Evidence:
   [`auth.ts`](../apps/mobile/src/lib/firebase/auth.ts) and
   [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts).
2. The desktop publishes a persistent Firestore index under
   `users/{uid}/desktops/{desktopId}/tasks`. It contains desktop and task IDs,
   desktop name, task titles, up to 500 characters of each prompt, up to 240
   characters of waiting/output preview, repo IDs and names, remote URL and
   hash, default branch, task branch and base ref, PR number and URL, agent and
   task state, transfer metadata, and timestamps. Evidence:
   [`cloud_task_publisher.rs`](../crates/kanna-server/src/cloud_task_publisher.rs),
   [`cloudTaskPublication.ts`](../services/relay/src/cloudTaskPublication.ts),
   and [`taskIndex.ts`](../apps/mobile/src/lib/firebase/taskIndex.ts).
3. The desktop also writes the signed-in account's primary email, UID-linked
   desktop credential hash, desktop ID, and desktop display name. Evidence:
   [`desktopCloudAssociation.ts`](../apps/desktop/src/services/desktopCloudAssociation.ts)
   and [`firestore.rules`](../firestore.rules).
4. The signed-in phone authenticates its relay WebSocket with a Firebase ID
   token. The relay routes task requests, task input, agent/terminal streams,
   file contents, and diffs between the phone and desktop. The router keeps
   connection and request-routing state in memory; the source does not persist
   those complete payloads. Evidence:
   [`relayClient.ts`](../apps/mobile/src/lib/transports/relayClient.ts),
   [`remoteTransport.ts`](../apps/mobile/src/lib/transports/remoteTransport.ts),
   and [`router.ts`](../services/relay/src/router.ts).
5. After notification permission is granted, the app obtains an FCM token and
   sends the Firebase ID token, Kanna mobile device ID, and FCM token to the
   relay. The relay stores the device ID and FCM token below the user's UID and
   sends notification title/body plus desktop ID and, for task notifications,
   task ID through Firebase Cloud Messaging. Evidence:
   [`mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts),
   [`auth.ts`](../services/relay/src/auth.ts), and
   [`mobileNotifications.ts`](../services/relay/src/mobileNotifications.ts),
   with the desktop-to-relay payload defined in
   [`relay_client.rs`](../crates/kanna-server/src/relay_client.rs).
6. Relay logs include remote IP address and, after authentication, UID, role,
   desktop ID, connection events, authentication failures, and error messages.
   Evidence: [`index.ts`](../services/relay/src/index.ts),
   [`auth.ts`](../services/relay/src/auth.ts), and
   [`router.ts`](../services/relay/src/router.ts).

Full terminal output, full file contents, full diffs, and task/agent input are
transported through the relay but are not written to Firestore or another
relay store by the reviewed source. Under Apple's real-time-request exception,
the complete transient streams are not independently disclosed as collection.
However, **Other User Content is still collected** because Firestore retains
task titles, prompt snippets, waiting/output previews, repository metadata,
branch names, and PR URLs.

### How to answer a form that cannot express both paths

Answer for the most inclusive behavior the shipped app supports: the
WAN/relay path. Do not answer "not collected" merely because a particular user
can stay on LAN or decline notification permission. Use the privacy policy or
Privacy Choices page to explain that LAN traffic stays local while signed-in
relay use creates the narrower account-linked cloud index and push
registration described above.

## Complete data-type worksheet

`No` in the Linked column means `No — this type is not collected`; App Store
Connect will not ask the linking or purpose follow-ups for an unselected type.
All tracking answers are `No` based on the reviewed source: it contains no ads,
data-broker sharing, or linking with third-party data for advertising or ad
measurement. Operational practices outside the repository still require the
human check below.

### Contact Info

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Name | No | No | No | N/A | Firebase `displayName` is read and cached locally, but the mobile sign-in flow does not ask for or write a person's name: [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts), [`sessionPersistence.ts`](../apps/mobile/src/state/sessionPersistence.ts). Desktop display names are machine names and are covered under identifiers/other data: [`desktopCloudAssociation.ts`](../apps/desktop/src/services/desktopCloudAssociation.ts). |
| Email Address | **Yes** | **Yes** | No | App Functionality — authentication and account management | Email/password is sent to Firebase Auth and email is mapped to the UID; the desktop also stores `primaryEmail` on `users/{uid}`: [`auth.ts`](../apps/mobile/src/lib/firebase/auth.ts), [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts), [`desktopCloudAssociation.ts`](../apps/desktop/src/services/desktopCloudAssociation.ts). |
| Phone Number | No | No | No | N/A | Only email/password authentication is implemented; no phone-auth dependency or flow exists: [`auth.ts`](../apps/mobile/src/lib/firebase/auth.ts), [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts), [`package.json`](../apps/mobile/package.json). |
| Physical Address | No | No | No | N/A | No address API, model, or input is present in the mobile dependency and account UI inventory: [`package.json`](../apps/mobile/package.json), [`AccountSheet.tsx`](../apps/mobile/src/components/AccountSheet.tsx). |
| Other User Contact Info | No | No | No | N/A | The account flow collects only email/password and exposes Firebase UID/email/display name: [`auth.ts`](../apps/mobile/src/lib/firebase/auth.ts), [`AccountSheet.tsx`](../apps/mobile/src/components/AccountSheet.tsx). |

Firebase Authentication also processes the password, user agent, and IP
address for authentication/security. Password is not a separate App Store
Connect data type. The IP mapping is addressed under diagnostics and the
coarse-location human decision below. Evidence:
[`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts) and Firebase's
[privacy and retention information](https://firebase.google.com/support/privacy/).

### Health & Fitness

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Health | No | No | No | N/A | No HealthKit, health, or medical dependency or feature exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Fitness | No | No | No | N/A | No motion, fitness, or exercise dependency or feature exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### Financial Info

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Payment Info | No | No | No | N/A | No payment or commerce SDK/flow exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Credit Info | No | No | No | N/A | No credit-data model, SDK, or input exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Other Financial Info | No | No | No | N/A | No financial-data model, SDK, or input exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### Location

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Precise Location | No | No | No | N/A | No location permission, location SDK, or coordinates are requested: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). Bonjour LAN discovery is not geographic location: [`bonjour.ts`](../apps/mobile/src/lib/discovery/bonjour.ts). |
| Coarse Location | **Requires human confirmation** | **Requires human confirmation** | No, unless an undisclosed tracking practice exists | If selected: App Functionality for security/debugging | Relay logs include the connection IP on the same connection that is associated with UID/role/desktop ID; Firebase Authentication also retains IP logs: [`index.ts`](../services/relay/src/index.ts), [`auth.ts`](../services/relay/src/auth.ts), [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts). Business/legal must decide whether operational retention or use treats IP as approximate location. |

### Sensitive Info and Contacts

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Sensitive Info | **Requires human confirmation** | **Requires human confirmation** | No, unless an undisclosed tracking practice exists | If selected: App Functionality | Task prompts and terminal output are generic free-form developer content; the product does not request an Apple-defined sensitive attribute. Prompt/output snippets can nevertheless contain secrets or confidential source code. Firestore retains snippets and the relay carries complete streams: [`cloud_task_publisher.rs`](../crates/kanna-server/src/cloud_task_publisher.rs), [`remoteTransport.ts`](../apps/mobile/src/lib/transports/remoteTransport.ts), [`router.ts`](../services/relay/src/router.ts). Business/legal must decide the policy/classification. |
| Contacts | No | No | No | N/A | No Contacts permission, address-book API, or contacts dependency exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### User Content

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Emails or Text Messages | No | No | No | N/A | Kanna has no interpersonal email/SMS/private-user-messaging feature. Agent/task free-form text is classified as Other User Content below: [`remoteTransport.ts`](../apps/mobile/src/lib/transports/remoteTransport.ts), [`api/types.ts`](../apps/mobile/src/lib/api/types.ts). |
| Photos or Videos | **Requires human confirmation** (see item 3) | Yes if collected | No | App Functionality — attach a photo to a message for the user's coding agent | Changed after this audit's preparation date, at runtime `2.2.0`. `expo-camera` is still only on-device QR scanning, but the task composer now lets a user attach one photo from the library or camera (`expo-image-picker`), downscales and re-encodes it on-device (`expo-image-manipulator`), and uploads it with the message. On the LAN path it never leaves the user's network. On the relay path it passes through relay in transit and relay does not persist it; the desktop stores it in the task's attachment directory and deletes it when the task closes. Whether transit through relay counts as collection is the same judgement already open for Other User Content: [`pickImageAttachment.ts`](../apps/mobile/src/lib/attachments/pickImageAttachment.ts), [`imageAttachmentBudget.ts`](../apps/mobile/src/lib/attachments/imageAttachmentBudget.ts), [`task_input_attachments.rs`](../crates/kanna-server/src/task_input_attachments.rs), [`router.ts`](../services/relay/src/router.ts). |
| Audio Data | No | No | No | N/A | No microphone/audio capture dependency or permission exists: camera audio recording is disabled, and the image-picker plugin is configured with `microphonePermission: false`, which is what keeps it from adding RECORD_AUDIO and a microphone usage string: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Gameplay Content | No | No | No | N/A | Kanna has no game functionality: [`package.json`](../apps/mobile/package.json), [`App.tsx`](../apps/mobile/src/App.tsx). |
| Customer Support | No | No | No | N/A | There is no in-app support submission. A user can copy a local diagnostic to the clipboard, but the app does not transmit it: [`MobileCrashBoundary.tsx`](../apps/mobile/src/components/MobileCrashBoundary.tsx), [`BuildInfoPanel.tsx`](../apps/mobile/src/components/BuildInfoPanel.tsx). |
| Other User Content | **Yes** | **Yes** | No | App Functionality — create, display, route, and notify about coding-agent tasks | Firestore retains task titles, up to 500 prompt characters, up to 240 output-preview characters, repo names/URLs, branch/base names, PR URLs, and task/agent metadata under the UID. FCM processes notification title/body and desktop/task IDs for delivery. Full prompts, agent/task input, terminal output, file contents, and diffs are relayed in real time but are not persisted by relay source: [`cloud_task_publisher.rs`](../crates/kanna-server/src/cloud_task_publisher.rs), [`cloudTaskPublication.ts`](../services/relay/src/cloudTaskPublication.ts), [`mobileNotifications.ts`](../services/relay/src/mobileNotifications.ts), [`remoteTransport.ts`](../apps/mobile/src/lib/transports/remoteTransport.ts), [`router.ts`](../services/relay/src/router.ts). |

### Browsing and Search History

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Browsing History | No | No | No | N/A | The terminal WebView renders bundled/local terminal HTML rather than recording open-web browsing: [`buildTerminalDocument.ts`](../apps/mobile/src/screens/buildTerminalDocument.ts), [`package.json`](../apps/mobile/package.json). |
| Search History | No | No | No | N/A | Cloud task search filters the already-loaded Firestore task index on-device; direct desktop searches are serviced by the desktop and are not stored by relay source: [`remoteTransport.ts`](../apps/mobile/src/lib/transports/remoteTransport.ts), [`router.ts`](../services/relay/src/router.ts). |

### Identifiers

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| User ID | **Yes** | **Yes** | No | App Functionality — authentication, authorization, account scoping, and routing | Firebase Auth generates/returns `uid`; Firestore uses `users/{uid}` and relay authentication/routes use the same UID: [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts), [`taskIndex.ts`](../apps/mobile/src/lib/firebase/taskIndex.ts), [`index.ts`](../services/relay/src/index.ts), [`cloudTaskPublication.ts`](../services/relay/src/cloudTaskPublication.ts). |
| Device ID | **Yes** | **Yes** | No | App Functionality — pairing/security, desktop routing, and push delivery | Kanna generates a persistent mobile device ID; LAN pairing sends it to the desktop; push registration stores it with the FCM token under the UID. Desktop IDs and credential hashes are also UID-linked, and Firebase Messaging records APNs/installation identifiers: [`appModel.ts`](../apps/mobile/src/appModel.ts), [`machinePairing.ts`](../apps/mobile/src/lib/pairing/machinePairing.ts), [`mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts), [`auth.ts`](../services/relay/src/auth.ts), [`desktopCloudAssociation.ts`](../apps/desktop/src/services/desktopCloudAssociation.ts). |

The FCM/APNs/Firebase installation identifiers are collected even though push
permission is optional: once permission is granted, collection is ongoing and
part of a supported shipped feature. Kanna does not use the advertising
identifier and has no App Tracking Transparency request in the reviewed
source. Evidence: [`mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts),
[`package.json`](../apps/mobile/package.json), and Firebase's
[Apple data-disclosure guidance](https://firebase.google.com/docs/ios/app-store-data-collection).

### Purchases

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Purchase History | No | No | No | N/A | No StoreKit, in-app purchase, subscription, or commerce integration exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### Usage Data

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Product Interaction | **Requires human confirmation** | **Requires human confirmation** | **Requires human confirmation** | If enabled: Analytics and/or App Functionality | No analytics API is imported and the production Google service plist sets `IS_ANALYTICS_ENABLED` to false. Firebase Messaging automatically logs notification interactions through Google Analytics only when Firebase Analytics is included. Confirm no analytics, campaign attribution, dashboard toggle, or monitoring is enabled operationally outside source: [`package.json`](../apps/mobile/package.json), [`GoogleService-Info.production.plist`](../apps/mobile/firebase/GoogleService-Info.production.plist), [`mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts). |
| Advertising Data | No | No | No | N/A | No advertising SDK or ad feature exists; the production Firebase plist sets `IS_ADS_ENABLED` to false: [`package.json`](../apps/mobile/package.json), [`GoogleService-Info.production.plist`](../apps/mobile/firebase/GoogleService-Info.production.plist). |
| Other Usage Data | No, subject to the Product Interaction operational check | No | No | N/A | Source contains no telemetry/event-upload path. Firebase Analytics, Performance, Crashlytics, and advertising packages are not direct dependencies: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### Diagnostics

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Crash Data | No | No | No | N/A | Up to five redacted crash diagnostics are retained only in AsyncStorage under `kanna.mobile.crash-diagnostics.v1`. The only export is an explicit user copy to the clipboard; there is no upload function or Crashlytics dependency: [`mobileCrashDiagnostics.ts`](../apps/mobile/src/lib/diagnostics/mobileCrashDiagnostics.ts), [`MobileCrashBoundary.tsx`](../apps/mobile/src/components/MobileCrashBoundary.tsx), [`BuildInfoPanel.tsx`](../apps/mobile/src/components/BuildInfoPanel.tsx), [`package.json`](../apps/mobile/package.json). |
| Performance Data | No | No | No | N/A | No Firebase Performance or other performance-monitoring SDK is directly included or called: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Other Diagnostic Data | **Yes** | **Yes** | No | App Functionality — authentication security, connection debugging, service reliability | Relay logs include IP address and authenticated UID/role/desktop ID, connection close codes/reasons, auth failures, and errors. Firebase Authentication also retains IP/user-agent security logs. Firebase dependencies may emit SDK-quality metadata described in Firebase's disclosure guide: [`index.ts`](../services/relay/src/index.ts), [`auth.ts`](../services/relay/src/auth.ts), [`router.ts`](../services/relay/src/router.ts), [`sdk.ts`](../apps/mobile/src/lib/firebase/sdk.ts), [`package.json`](../apps/mobile/package.json). |

Do not classify the local crash records as collected diagnostics unless the
shipping product adds an upload path or business operations instruct users to
submit them in a way that fails Apple's optional-disclosure criteria. Their
presence in AsyncStorage alone is not collection.

### Surroundings and Body

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Environment Scanning | No | No | No | N/A | Camera use is limited to local QR barcode recognition; no mesh, plane, scene, or uploaded image data exists: [`MachinePairingSheet.tsx`](../apps/mobile/src/components/MachinePairingSheet.tsx), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Hands | No | No | No | N/A | No hand/body tracking framework or feature exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |
| Head | No | No | No | N/A | No head/body tracking framework or feature exists: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts). |

### Other Data

| Data type | Collected | Linked to identity | Used for tracking | Purpose | Source evidence |
| --- | --- | --- | --- | --- | --- |
| Other Data Types | **Yes** | **Yes** | No | App Functionality for push delivery; Analytics for Firebase's unlinked SDK/platform-adoption metadata | Firebase Messaging's documented collection includes device model, language, time zone, OS version, app identifier/version, APNs token, and Firebase installation/FCM identifier. Kanna includes and invokes native Firebase Messaging, and stores the returned FCM token under UID. Answer Linked = Yes because at least the push-token/device-metadata subset is associated with a device and Kanna account, even though Firebase says its separate user-agent/platform-adoption metadata is unlinked: [`package.json`](../apps/mobile/package.json), [`app.config.ts`](../apps/mobile/app.config.ts), [`mobilePush.ts`](../apps/mobile/src/lib/notifications/mobilePush.ts), [`auth.ts`](../services/relay/src/auth.ts). |

## Requires human confirmation

Resolve and record these decisions before publishing the label. They depend on
business/legal facts or production configuration that source code cannot
establish.

1. **IP address as Coarse Location.** The relay emits remote IP addresses to
   logs and emits UID/role/desktop ID for the authenticated connection.
   Firebase Authentication also retains IP security logs. Does any relay,
   Firebase, Google Cloud, CDN/proxy, or log platform retain or analyze these
   IPs as approximate location? If yes, select **Coarse Location**, **Linked to
   identity: Yes** where the retained record can be associated with the UID or
   device, **Tracking: No**, purpose **App Functionality**. If IP is used only
   as diagnostic/security data and never derived into location, retain only
   the Other Diagnostic Data answer. This is a business/legal classification,
   not a source-code guess.
2. **Sensitive Info in task/terminal content.** Can task prompts, waiting
   previews, terminal output, repo metadata, or code content be considered an
   intentional collection of Apple's defined Sensitive Info, rather than
   generic free-form Other User Content that may incidentally contain secrets
   or confidential code? Confirm that the privacy policy describes this risk.
   If legal says yes, select **Sensitive Info**, **Linked to identity: Yes**,
   **Tracking: No**, purpose **App Functionality**.
3. **Photos attached to agent messages.** The composer photo attachment
   (runtime `2.2.0`, added after this sheet's preparation date) sends a
   user-selected image to the user's own desktop. On the LAN path nothing
   leaves the local network. On the relay path the image passes through relay
   in transit and is not persisted there, exactly like the prompt and terminal
   content already classified as Other User Content — but Apple's **Photos or
   Videos** type is separate, and whether library/camera media in transit is
   "collected" is the same business/legal call as item 2, not a source-code
   guess. If legal says yes, select **Photos or Videos**, **Linked to identity:
   Yes**, **Tracking: No**, purpose **App Functionality**. Also confirm the
   privacy policy describes photo attachments, and re-check the photo-library
   and camera usage strings in
   [`app.config.ts`](../apps/mobile/app.config.ts).
4. **Operational analytics or monitoring outside source.** Confirm whether
   Firebase/Google Analytics, notification campaign reporting, App Store
   campaign attribution, product analytics, CDN analytics, crash reporting,
   performance monitoring, or another telemetry service is enabled in the
   production project or deployment despite not being called by this source.
   If anything is enabled, inventory its exact events, identifiers, retention,
   linking, tracking, and purposes, then add **Product Interaction**, **Other
   Usage Data**, **Crash Data**, **Performance Data**, or another applicable
   type. Also re-check the native archive's embedded privacy manifests and
   CocoaPods targets against Firebase's current disclosure guide.

## Final submitter checklist

- Confirm the build being submitted is production `build.kanna.app`, and note
  its runtime version. This sheet was prepared against `2.1.4`; runtime `2.2.0`
  added composer photo attachments, so a `2.2.0`-or-later build must resolve
  the **Photos or Videos** question in item 3 before the label is published.
- Answer **Yes, we collect data from this app**.
- Select and complete Email Address, Other User Content, User ID, Device ID,
  Other Diagnostic Data, and Other Data Types using the summary above.
- Resolve all three **Requires human confirmation** items and add any resulting
  conditional types.
- Keep **Used for Tracking: No** only after confirming there is no operational
  advertising measurement, cross-company data linking, or data-broker sharing.
- Verify the public privacy policy covers Firebase Auth/Firestore/FCM, relay
  routing and logs, cloud task snippets/metadata, LAN pairing, camera QR use,
  local-only crash diagnostics, retention/deletion, and the LAN/WAN difference.
- Review the exact submitted archive's privacy manifests and third-party native
  targets. Update this worksheet and App Store Connect if the archive differs
  from the source inventory.
