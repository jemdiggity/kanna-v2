# Kanna Mobile App Review Notes (2026-08-08)

## Submitter preamble — do not paste this section

The text below is written for the verified remote-review setup: the dedicated
iMac stays online, the desktop app and mobile app use the same review account,
and seeded demo tasks are available through the production relay. Immediately
before submission, replace both credential placeholders and confirm the iMac
appears under **Machines** as **Available through your account**.

The review flow deliberately invites only reading the task lists, opening a
seeded task, watching its existing output, and sending one constrained message
that expressly forbids commands and file changes. It deliberately leaves out
**Add task**, repository commands under **More**, machine pairing/removal, agent
permission and stop controls, and task actions such as advancing or closing a
task. Those actions can spawn real agent CLIs, execute commands against the
repo, or change task state on the review iMac.

> **Human safety decision:** Whoever operates the iMac must decide whether the
> demo repository, its credentials, and its agent configuration are safe for an
> unknown third party to drive, even within the bounded flow below. Confirm in
> particular that the selected demo task can safely receive the exact review
> message. This is a human security and operations decision, not a decision made
> by the authoring agent. Do not submit these notes or credentials until that
> person approves the setup.

## App Review Notes — paste the text inside this block

```text
Kanna for iOS is a companion app and requires the Kanna desktop app for macOS, which owns the repositories, coding-agent processes, tasks, and terminal sessions shown on the phone. When the phone and desktop are on the same local network, the user pairs them by QR code and connects over LAN without an account; away from that network, remote access requires an account and connects through the Kanna relay.

REVIEW ACCOUNT — SUBMITTER MUST REPLACE BOTH PLACEHOLDERS:
Email: [SUBMITTER: ENTER THE APP REVIEW ACCOUNT EMAIL]
Password: [SUBMITTER: ENTER THE APP REVIEW ACCOUNT PASSWORD]

Review environment

A dedicated iMac will remain online throughout review with Kanna for macOS running, signed in to the same review account, and populated with demo tasks. You do not need to install the macOS app or interact with the iMac. The review device reaches that iMac remotely through wss://relay.kanna.build; it is not expected to be on the iMac's local network.

Review flow

1. Launch Kanna. The Tasks screen and the account badge in the upper-right corner are visible. If iOS presents the Local Network permission prompt, it is safe to allow it; LAN discovery will not find the remote review iMac, which is expected.
2. Tap the account badge, enter the review credentials above, and tap Sign In. The badge changes to the review account with a green status dot, and the seeded task data becomes available.
3. Tap the account badge again, then Machines. The review iMac appears in Available with the Account badge and the status “Available through your account.” This confirms the remote relay path is connected. Tap Back.
4. Open Activity and select one of the existing demo tasks. The list shows the repository name, task title, and workflow stage; selecting a task opens its detail view.
5. Observe the task detail view. Its title and stage remain at the top while the coding agent's terminal or structured agent output is rendered below.
6. In the Reply field, send exactly: App Review smoke test: reply “Received” only. Do not run commands or modify files. The submitted input and the agent's acknowledgement become visible in the task output.

Please stop after step 6. Kanna can also create tasks, run configured repository commands, control agent permissions, and advance or close tasks, but those controls invoke real coding-agent CLIs or change the demo workspace and are not needed for this review. Please do not use Add task, More repository commands, the task-action + button, Stop, or permission controls.

Local Network permission

The Local Network permission supports the normal account-free LAN workflow. After a phone has been paired with a Kanna desktop, the app uses Bonjour service _kanna-mobile._tcp to discover that paired desktop and connect to its local API. Because the App Review device is remote from the review iMac's network, that discovery will find nothing during the flow above; this is expected, and the signed-in relay connection provides access instead.

WebView and displayed developer content

The embedded WebView is a local terminal renderer, not a general web browser. It renders app-generated terminal UI for output received from the connected Kanna desktop and does not provide general-purpose web navigation.

Kanna is a developer tool. The demo workspace may therefore display repository names, branch names, task prompts, terminal output, and coding-agent messages.
```
