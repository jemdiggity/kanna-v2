# Kanna Mobile Support

Kanna Mobile is a companion for the Kanna desktop app for macOS. It lets you view and control coding-agent tasks from an iPhone. A Mac running the Kanna desktop app is required; the mobile app is not a standalone coding-agent host.

## Pair over your local network

1. Put the iPhone and Mac on the same trusted local network and open Kanna on both devices.
2. In the desktop app, open **Preferences → Mobile** and select **Start pairing**.
3. In Kanna Mobile, open **Machines**, select **Add**, and scan the QR code shown on the Mac. You can instead enter the six-character pairing code.
4. If pairing fails, confirm that local-network and camera permissions are allowed as needed, both apps remain open, and the pairing code has not expired. Camera access is optional when you enter the code manually.

Direct LAN access uses a device ID and secret issued by the Mac. Removing a machine in Kanna Mobile removes that manual pairing from the phone; you can pair it again later.

Source: [desktop Mobile Access panel](https://github.com/tampopogk/kanna/blob/main/apps/desktop/src/components/MobileAccessPanel.vue), [mobile Machines screen](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/screens/MachinesScreen.tsx), and [pairing implementation](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/pairing/machinePairing.ts).

## Cloud access

Cloud access lets a signed-in Kanna Mobile app reach an authenticated desktop when the phone is away from the Mac's local network. It uses a Kanna account and Kanna's Firebase and relay services. There is no cloud purchase or account-creation flow in the current mobile app.

To request a Kanna account or cloud access, contact [BUSINESS DECISION: insert the monitored cloud-access email address or request-form URL, plus any information the requester should provide].

Source: [mobile environment configuration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/mobileEnvironments.json), [Firebase authentication](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/sdk.ts), and [current App Store review audit](https://github.com/tampopogk/kanna/blob/main/docs/mobile-app-store-review-audit.md).

## Get help

For pairing, sign-in, connectivity, notification, or task-control help, contact [BUSINESS DECISION: insert the monitored support email address or support-form URL]. Include the Kanna Mobile version, iOS version, Mac model and macOS version, and a short description of what happened. Do not send passwords, Firebase tokens, pairing secrets, source code, terminal output, or repository credentials unless support explicitly provides an approved secure method.

[BUSINESS DECISION: insert supported languages, support hours, and expected response time, or remove this placeholder if none will be promised.]

## Account and data deletion

Kanna Mobile does not currently include an in-app account-deletion workflow. To request deletion of your Kanna account or Kanna-hosted data, contact [BUSINESS DECISION: insert the monitored privacy email address or deletion-request form URL]. Send the request from, or identify, the email address associated with the account. Never include your password or other credentials.

[BUSINESS DECISION: insert the identity-verification steps, deletion scope, completion timeframe, lawful retention exceptions, and confirmation process.]

You can remove a manual LAN pairing from the **Machines** screen and clear locally retained crash diagnostics under **About this build**. Account deletion does not automatically erase data stored separately on your Mac, in local app storage, in a source-control provider, or by an agent provider.

Source: [current App Store review audit](https://github.com/tampopogk/kanna/blob/main/docs/mobile-app-store-review-audit.md), [machine removal UI](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/screens/MachinesScreen.tsx), and [diagnostic controls](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/BuildInfoPanel.tsx).

For details about what Kanna Mobile handles, see the [Kanna Mobile Privacy Policy](https://kanna.build/privacy).
