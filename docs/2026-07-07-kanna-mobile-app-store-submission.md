# Kanna Mobile App Store Submission Package

Last prepared: 2026-07-07

This package is a working reference for the human App Store Connect submitter.
It is not legal advice. Anything marked "Requires human confirmation" must be
confirmed by the business/legal owner before submission.

Official references:

- Apple App Privacy details: https://developer.apple.com/app-store/app-privacy-details/
- App Store Connect app privacy help: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/
- Apple product page metadata guidance: https://developer.apple.com/app-store/product-page/
- Apple App Review guidance: https://developer.apple.com/distribute/app-review/
- Firebase Apple data disclosure guide: https://firebase.google.com/docs/ios/app-store-data-collection

## Submission Identity

Source-backed production identity:

- App display name: `Kanna`
- Bundle ID: `build.kanna.app`
- Scheme: `kanna`
- Firebase project: `kanna-build`
- Relay: `wss://relay.kanna.build`
- OTA channel: `production`
- Runtime version: `1.0.0`
- OTA manifest URL: `https://relay.kanna.build/ota/manifest`

Sources:

- `apps/mobile/src/mobileEnvironments.json`
- `apps/mobile/app.config.ts`
- `apps/mobile/firebase/GoogleService-Info.production.plist`
- `docs/specs/mobile-ota-updates.md`

## Source Inventory

Mobile app dependencies from `apps/mobile/package.json`:

- Runtime: Expo 57, React Native 0.86, React 19.2.
- Storage: `@react-native-async-storage/async-storage`.
- Cloud/backend: `firebase`.
- Terminal: `@xterm/xterm`, `@xterm/addon-fit`, `react-native-webview`.
- Updates/config: `expo-updates`, `expo-constants`, `expo-modules-core`.
- Navigation/icons: React Navigation, Expo vector icons.
- No intentional mobile analytics, ads, crash reporting, push notification,
  camera, location, contacts, photo library, microphone, or ATT dependency was
  found in the mobile source inventory.

Native/iOS behaviors:

- `apps/mobile/plugins/withKannaBonjour.js` adds `NSBonjourServices` with
  `_kanna-mobile._tcp`.
- The same plugin sets `NSLocalNetworkUsageDescription` to:
  `Kanna discovers trusted desktop apps on your local network.`
- `TerminalWebView` renders local HTML built by `buildTerminalDocument`; it is a
  terminal viewer, not a general web browser.
- `expo-updates` checks Kanna's relay for signed OTA updates on startup and
  foreground, throttled in app code.

Authentication and persistence:

- Email/password sign-in is implemented with Firebase Auth.
- The app maps Firebase users to `uid`, `email`, and `displayName`.
- Firebase Auth persistence is stored locally through AsyncStorage with the
  `firebaseAuth:` prefix.
- Kanna-specific local session context is stored in AsyncStorage under
  `kanna.mobile.context.v1`; it can include selected desktop/repo/task IDs,
  active view, cached auth user, trusted desktops, LAN endpoints, and recent
  repo creation preferences.

Cloud and relay data flow:

- Signed-in mobile clients authenticate to the relay with a Firebase ID token.
- The app reads Firestore task indexes under
  `users/{uid}/desktops/{desktopDocId}/tasks`.
- Firestore rules allow signed-in users to read their own desktop/task index;
  task publication writes are restricted to the relay's Admin SDK.
- The relay authenticates mobile WebSockets with Firebase Auth ID tokens and
  routes task requests/terminal streams to the user's desktop.
- Relay server logs include connection/auth events that can include remote IP
  address, user ID, role, desktop ID, and error messages.

Task data synced by `kanna-server` through the authenticated relay:

- Desktop display name and desktop ID.
- User primary email on `users/{uid}` when available.
- Task title and prompt snippet, capped at 500 characters.
- Task stage/status/activity, branch/base ref, PR number/URL, agent provider
  and agent type, created/updated/closed timestamps.
- Repo name, local repo ID, remote URL when available, remote URL hash, default
  branch.
- Desktop credential hash for relay authentication.

Sources:

- `apps/mobile/src/lib/firebase/auth.ts`
- `apps/mobile/src/lib/firebase/sdk.ts`
- `apps/mobile/src/lib/firebase/authPersistence.ts`
- `apps/mobile/src/lib/firebase/taskIndex.ts`
- `apps/mobile/src/state/sessionPersistence.ts`
- `apps/mobile/src/appModel.ts`
- `apps/mobile/src/lib/transports/relayClient.ts`
- `apps/mobile/src/lib/transports/lanTransport.ts`
- `services/relay/src/index.ts`
- `services/relay/src/auth.ts`
- `apps/desktop/src/services/desktopCloudAssociation.ts`
- `crates/kanna-server/src/cloud_task_publisher.rs`
- `services/relay/src/cloudTaskPublication.ts`
- `firestore.rules`

## App Privacy Label Guidance

Recommended working assumption:

- Data is linked to the user's identity when it is stored or routed under the
  Firebase Auth UID, email, or signed-in account.
- Data is not used for third-party advertising or cross-app/site tracking unless
  the business has enabled a practice outside this source inventory.
- Firebase, Google Cloud/Firebase hosting, and the Kanna relay are third-party
  or service-provider systems involved in app functionality.
- Local-only AsyncStorage state is not App Store "collected" unless transmitted
  to Kanna, Firebase, the relay, or another service.

Likely App Privacy categories to disclose as collected and linked to user:

| App Privacy category | Specific data | Purpose | Source-backed basis |
| --- | --- | --- | --- |
| Contact Info | Email address | App functionality, account management | Firebase Auth email sign-in; desktop writes `primaryEmail` |
| User Content | Task prompts, terminal input/output, task titles/snippets, agent messages, repo/task metadata | App functionality | task creation/input, relay streams, Firestore task snapshots |
| Identifiers | User ID | App functionality | Firebase Auth `uid`; Firestore paths and relay auth |
| Identifiers | Desktop identifiers and server device tokens | App functionality | desktop IDs, Kanna server device-token relay path |
| Diagnostics or Other Data | Server logs containing IP address, auth failures, connection events | App functionality, security, debugging | relay logs connection/auth events |

Potential categories that require business/legal confirmation:

- Location / coarse location: Requires human confirmation. Question: are relay,
  Firebase, CDN, or other server logs retained or analyzed in a way that treats
  IP address as approximate location under the privacy label?
- Diagnostics: Requires human confirmation. Question: are production crash logs,
  OS logs, Expo logs, Firebase console logs, or third-party monitoring tools
  collected outside the source inventory?
- Product Interaction: Requires human confirmation. Question: is there any
  product analytics, telemetry, App Store campaign attribution, website event
  join, or Firebase/Google Analytics enabled operationally even though the
  source does not call mobile analytics APIs?
- Other User Content: Requires human confirmation. Question: should repository
  names, remote URLs, branch names, PR URLs, terminal output, and code snippets
  be grouped as "Other User Content" or split under another App Store Connect
  data type based on the current form wording?
- Sensitive Info: Requires human confirmation. Question: can task prompts or
  terminal output contain secrets or confidential source code by product design,
  and how does the privacy policy describe this risk?

Likely "not collected" or "not used" answers based on this source inventory:

- Tracking: No, unless business practices outside the app source combine Kanna
  data with third-party data for advertising or measurement.
- Data used for third-party advertising: No source evidence.
- Data used for developer advertising or marketing: No source evidence.
- Precise location: No source evidence.
- Contacts, photos/videos, audio, camera, microphone, health/fitness, financial
  info, payment info, browsing history, search history: No source evidence.
- Crash data/performance data: No intentional mobile SDK in source, but confirm
  production infrastructure and App Store diagnostics choices.

Firebase notes:

- The production Google service plist has `IS_ANALYTICS_ENABLED` set to false
  and the mobile app does not import `firebase/analytics`.
- The Firebase package can include transitive modules in the lockfile; answer
  based on SDK targets actually bundled and product features used.
- Kanna Mobile uses the Firebase JavaScript package from React Native/Expo, not
  an explicit native `@react-native-firebase/*` package in this inventory, but
  Firebase's current Apple data disclosure guide should still be reviewed for
  relevant bundled SDK behavior and service-side collection.
- Review Firebase's current Apple data disclosure guide before final submission,
  because App Store labels must include relevant third-party SDK practices.

## Privacy Policy Requirements

Privacy policy URL placeholder:

- `https://kanna.build/privacy`

Requires human confirmation:

- Is this URL live, publicly accessible without authentication, and stable?
- Does the policy identify data Kanna collects, how it is collected, all uses,
  third-party processors, retention, deletion, account revocation, and support
  contact paths?
- Does the policy explicitly cover Firebase Auth/Firestore, Google Cloud/GCS,
  relay WebSocket transport, local network discovery, OTA updates, server logs,
  and code/task content users send through Kanna?
- Does the policy state whether Kanna sells/shares personal data or uses data
  for tracking under applicable privacy laws?
- What is the data deletion flow for Firebase Auth accounts, Firestore task
  snapshots, relay logs, OTA logs, and desktop-published metadata?

## App Review Notes Draft

Use this as the App Review notes body, then replace placeholders.

```text
Kanna is a companion app for the Kanna desktop app. It lets a signed-in developer
view agent coding tasks, create new tasks, watch terminal/agent output, and send
input to a trusted desktop running Kanna.

Review account:
- Email: <REQUIRES HUMAN CONFIRMATION>
- Password: <REQUIRES HUMAN CONFIRMATION>

Backend availability:
- Production Firebase project: kanna-build
- Production relay: wss://relay.kanna.build
- The relay and Firebase backend must remain available during review.

Desktop pairing and local network:
- Kanna can connect over the internet relay after sign-in, or over the local
  network to a trusted Kanna desktop.
- The local network permission is used only to discover trusted desktop apps via
  Bonjour service _kanna-mobile._tcp and to connect to the desktop's local API.
- If iOS prompts for Local Network permission, allow it to test LAN discovery.

Suggested review flow:
1. Launch Kanna and sign in with the review account.
2. Confirm the app shows Kanna Cloud / a trusted desktop connection.
3. Open the Tasks tab and select an existing demo task.
4. Confirm terminal or agent output is visible.
5. Send a short input message such as "App Review smoke test".
6. Open More and verify refresh, desktop list, and task controls are visible.
7. Create a task only if the provided desktop is online and marked as safe for review.

Important:
- The app is a developer tool and may display source-code repository names,
  branch names, task prompts, terminal output, and agent messages from the
  review demo workspace.
- The embedded WebView is a local terminal renderer. It does not provide general
  web browsing.
- OTA updates are code-signed and served from https://relay.kanna.build/ota/manifest.
```

Requires human confirmation:

- Provide a production review account.
- Keep a review desktop online and paired to that account, or seed enough cloud
  task data for review without desktop control.
- Confirm what App Review is allowed to do: create tasks, send terminal input,
  advance stages, run merge agent, close tasks.
- Confirm the demo repository contains no private customer data, secrets, or
  unsafe commands.
- Confirm support contact details for App Review escalation.

## App Store Metadata Skeleton

App name:

- `Kanna`

Subtitle ideas:

- `Coding agents from your phone`
- `Remote control for agent tasks`
- `Track AI coding work anywhere`

Description draft:

```text
Kanna helps developers manage coding-agent work from iPhone.

Connect Kanna Mobile to the Kanna desktop app to follow active tasks, inspect
agent and terminal output, create new tasks, and send input when an agent needs
direction. Kanna is built for developers who run multiple Claude, Copilot,
Codex, OpenCode, or Antigravity tasks across repositories and want a focused
mobile companion instead of juggling remote terminals.

Features:
- View recent agent tasks and repository task lists
- Open task detail and watch terminal or agent output
- Send follow-up instructions to running tasks
- Create new desktop-backed coding-agent tasks
- Connect through the Kanna relay or trusted local network discovery

Kanna Mobile requires a Kanna account and a Kanna desktop app configured for
mobile access.
```

Promotional text ideas:

- `Monitor coding-agent tasks, create new work, and send input to your Kanna desktop from iPhone.`

Keyword ideas:

- `developer,terminal,coding,agents,claude,copilot,codex,workflow,git,tasks,remote`

Category recommendation:

- Primary: Developer Tools
- Secondary: Productivity

Support URL placeholder:

- `https://kanna.build/support`

Marketing URL placeholder:

- `https://kanna.build`

Privacy URL placeholder:

- `https://kanna.build/privacy`

Copyright:

- Requires human confirmation. Suggested format: `<YEAR> <LEGAL ENTITY NAME>`.

App review contact:

- Requires human confirmation: name, phone, email.

## Screenshot Checklist

Required screenshot sets depend on App Store Connect's current device matrix.
Capture at least the required iPhone sizes for the first submission, with iPad
only if the app supports iPad for release.

Recommended screenshot sequence:

1. Tasks list connected to Kanna Cloud or a trusted desktop.
2. Task detail with terminal/agent output visible.
3. Create task composer with machine and agent options.
4. Desktops screen showing trusted desktop status.
5. Account sheet showing signed-in state and local network connection status.
6. More screen with refresh/task controls.

Screenshot rules:

- Use production display name `Kanna`, not `Kanna Dev` or `Kanna Staging`.
- Use a demo account and demo repository only.
- Avoid private source code, secrets, customer data, personal email inboxes, or
  terminal output that implies unsafe commands.
- If screenshots show email addresses, use review/demo identities.
- Include local network or desktop pairing only as product context, not as
  troubleshooting copy.

## Age Rating Notes

Suggested starting point:

- Likely 4+ if the submitted app is positioned as a developer productivity tool,
  contains no public user-generated content, no social features, no commerce,
  no gambling, no medical content, no unrestricted web browsing, and no mature
  content generated by Kanna itself.

Requires human confirmation:

- Does App Store Connect consider terminal/agent output from user repositories
  "user-generated content" for this app?
- Could demo or normal task output display profanity, mature text, violent text,
  illegal instructions, or other content requiring a higher rating?
- Should "Unrestricted Web Access" be answered No because the WebView is local
  terminal HTML only?
- Is the app limited to iPhone, or does it also support iPad and require iPad
  age-rating/screenshot coverage?

## Pricing, Availability, And Distribution

Suggested App Store choices:

- Pricing: Free, no in-app purchases, unless the business has a paid mobile
  plan or subscription launch.
- Availability: Requires human confirmation. Select territories where Kanna has
  legal, support, privacy, and backend coverage.
- Distribution: Public App Store if the production desktop app and backend are
  ready for public users. Use TestFlight only until production review account,
  support, privacy policy, backend uptime, and demo data are ready.
- Sign-in: Account required. The App Review notes must provide credentials.
- External purchase: No in-app purchasing flow appears in mobile source.

Requires human confirmation:

- Is Kanna Mobile free at launch?
- Which territories should be selected?
- Is the desktop companion publicly available and documented for users at
  submission time?
- Are there export compliance or encryption answers needed for WebSocket/TLS,
  Firebase, and OTA code signing?
- Are there account deletion requirements implemented and documented for the
  submitted build?

## Accessibility Submission Notes

Source inventory found many explicit accessibility labels on account, update,
toolbar, and some control buttons. Several Pressables rely on visible text or
test IDs rather than explicit accessibility labels, especially in task/detail,
composer, desktop list, and agent permission controls.

Before submission, consider a focused VoiceOver pass:

- Sign in, open account sheet, and sign out.
- Navigate tabs in the floating toolbar.
- Open a task and return to the list.
- Use the task input field and send button.
- Open the composer, choose machine/agent, type a prompt, close the modal.
- Confirm the terminal WebView exposes a useful accessible label or surrounding
  context instead of trapping VoiceOver users in raw terminal HTML.

Requires human confirmation:

- Is accessibility remediation in scope before App Store submission, or should
  this be tracked as a follow-up?

## Pre-Submission Checklist

- Build uses `KANNA_APP_ENV=prod`.
- Bundle ID is `build.kanna.app`.
- Display name is `Kanna`.
- Production relay health is green: `https://relay.kanna.build/health`.
- Production OTA manifest responds for the current runtime/channel.
- Firebase Auth email/password sign-in works for the review account.
- Firestore rules deployed for `kanna-build`.
- A review desktop is online and paired, or cloud task data is seeded.
- Privacy policy and support URLs are live.
- App Privacy answers are reviewed by business/legal.
- Screenshots use production app identity and demo data.
- App Review notes include credentials and safe test instructions.
