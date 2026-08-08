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

To request a Kanna account or cloud access, email **support@tampopomyoko.com** with the subject "Cloud access". Tell us the email address you want the account created for and roughly what you plan to use Kanna for. Cloud access is granted manually, so please allow some time for a reply.

Source: [mobile environment configuration](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/mobileEnvironments.json), [Firebase authentication](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/lib/firebase/sdk.ts), and [current App Store review audit](https://github.com/tampopogk/kanna/blob/main/docs/mobile-app-store-review-audit.md).

## Get help

For pairing, sign-in, connectivity, notification, or task-control help, email **support@tampopomyoko.com**. Include the Kanna Mobile version, iOS version, Mac model and macOS version, and a short description of what happened. Do not send passwords, Firebase tokens, pairing secrets, source code, terminal output, or repository credentials unless support explicitly provides an approved secure method.

## Account and data deletion

Kanna Mobile does not currently include an in-app account-deletion workflow. To request deletion of your Kanna account or Kanna-hosted data, email **support@tampopomyoko.com** with the subject "Delete my account". Send the request from the email address associated with the account, or identify that address in the message. Never include your password or other credentials.

We verify a deletion request by confirming it comes from the account's own email address; if it does not, we will write to that address before acting. A verified request removes your Firebase Authentication account and the Kanna-hosted records tied to it: your account document, your desktop and cloud task index, stored desktop credential hashes, and any push-notification registrations. We complete verified deletions within 30 days and email you when it is done. Copies may persist briefly in routine backups until those backups age out on their normal cycle, and we may retain the minimum needed to meet a legal obligation or to resolve a dispute.

You can remove a manual LAN pairing from the **Machines** screen and clear locally retained crash diagnostics under **About this build**. Account deletion does not automatically erase data stored separately on your Mac, in local app storage, in a source-control provider, or by an agent provider.

Source: [current App Store review audit](https://github.com/tampopogk/kanna/blob/main/docs/mobile-app-store-review-audit.md), [machine removal UI](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/screens/MachinesScreen.tsx), and [diagnostic controls](https://github.com/tampopogk/kanna/blob/main/apps/mobile/src/components/BuildInfoPanel.tsx).

For details about what Kanna Mobile handles, see the [Kanna Mobile Privacy Policy](https://kanna.build/privacy).
