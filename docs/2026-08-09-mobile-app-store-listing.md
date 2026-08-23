# Kanna Mobile — App Store Listing Copy

Drafted 2026-08-09. This is item **S2** in
[`2026-08-08-mobile-ios-first-release-readiness.md`](2026-08-08-mobile-ios-first-release-readiness.md).

Paste-ready copy for the App Store Connect product page, written against the
app as it actually behaves after the 2026-08-09 merges. It supersedes the
"App Store Metadata Skeleton" in
[`2026-07-07-kanna-mobile-app-store-submission.md`](2026-07-07-kanna-mobile-app-store-submission.md),
which predates the companion-app framing.

Every field below is within Apple's current limit, with the character count
shown except for keywords, whose limit is measured in bytes. Verify limits in
App Store Connect at submission time — Apple changes them occasionally.

## App name — 5 / 30

```text
Kanna
```

Reserve this early; short product names go quickly. If `Kanna` is taken, the
fallback that keeps the brand is `Kanna Agents` (12).

## Subtitle — 29 / 30

```text
Coding agents from your phone
```

At 29 characters this is one under the limit, so it cannot absorb an edit —
change it wholesale rather than tweaking.

## Promotional text — 136 / 170

Editable without submitting a new build, so use it for whatever is currently
true rather than evergreen copy.

```text
Watch your Mac's coding agents from anywhere. Follow tasks, read terminal output, and send new instructions without opening your laptop.
```

## Description — 1,691 / 4,000

```text
Kanna Mobile is a companion for the Kanna desktop app for macOS. It lets you follow and steer coding-agent tasks from your iPhone while the work runs on your Mac.

Kanna Mobile requires a Mac running the Kanna desktop app. It is not a standalone coding-agent host, and it does not run agents on your phone.

WHAT YOU CAN DO

• See every task across your repositories, grouped by status and activity
• Open a task and watch its terminal and agent output stream live
• Send follow-up instructions when an agent stops and asks a question
• Start new tasks against a repository and agent of your choosing
• Review diffs and file contents an agent has touched
• Get a notification when a task needs you

TWO WAYS TO CONNECT

On your local network, pair directly with your Mac by scanning a QR code. No account, no sign-up, nothing leaves your network.

Away from home, cloud access relays the connection between your phone and your Mac. Create a Kanna account in the app, verify your email, and subscribe to Kanna Cloud to connect remotely.

BUILT FOR PEOPLE RUNNING SEVERAL AGENTS

Kanna gives every task its own git worktree, branch, and agent session, then moves it through a workflow: implement, review, pull request. Kanna Mobile is the window into that from wherever you are — a build you kicked off before lunch, an agent stuck on a question, a review you want to read on the train.

Kanna works with the coding-agent CLIs you already have installed on your Mac.

A NOTE ON WHAT YOU'LL SEE

Kanna is a developer tool. It displays repository names, branch names, task prompts, and raw terminal output from your own machine.

Requires the Kanna desktop app for macOS, available at kanna.build.
```

## Keywords — 81 / 100 bytes

Comma-separated, no spaces after commas (spaces consume bytes).

```text
developer,terminal,coding,agent,git,tasks,remote,workflow,devtools,ssh,repo,build
```

**Deliberately excluded: `claude`, `codex`, `copilot`.** They would be the
highest-traffic terms, but they are other companies' trademarks, and Apple
rejects keyword fields that use third-party marks to capture their search
traffic. The description mentions "coding-agent CLIs" generically for the same
reason. If you want the traffic, that is a legal call to make knowingly, not a
default.

## First-version note

App Store Connect does not provide **What's New in this Version** for an app's
first version. Do not look for or paste release notes for 1.0.0.

The following copy can instead be used for TestFlight's **What to Test** field,
or saved for a later update:

```text
First release of Kanna Mobile.

Pair with your Mac over your local network by scanning a QR code, or connect from anywhere with cloud access. Follow tasks, watch terminal and agent output live, send instructions to a running agent, and start new work — all from your phone.
```

## Category and rating

- Primary: **Developer Tools**
- Secondary: **Productivity**
- Age rating: **4+** is the expected calculated result, but complete Apple's
  current questionnaire and use its result. The app has no broadly distributed
  user-generated content, social feed, person-to-person messaging, commerce,
  gambling, or unrestricted web access — its WebView is a local terminal
  renderer only.

For the age-rating question, repository and terminal content is not broadly
distributed to other users as part of Kanna's intended experience: there is no
feed, messaging, sharing, or discovery surface. Answer based on the submitted
build and Apple's current wording rather than treating all free-form developer
content as social UGC.

## Fields that are still yours

- **Support URL**: `https://kanna.build/support/`
- **Marketing URL**: `https://kanna.build`
- **Privacy Policy URL**: `https://kanna.build/privacy/`
- **Copyright**: `2026 Tampopo LLC`
- **App Review contact**: name, phone, email — item S4, not derivable from the
  repo.
- **Content Rights**: human confirmation required. Kanna can display repository,
  pull-request, and agent output supplied by its operator; Tampopo LLC must
  confirm the app is permitted to access that content in every selected
  territory.
- **DSA trader status**: declare Tampopo LLC's status and complete Apple's
  verification before selecting EU territories.
- **Version release setting**: manual release is recommended for 1.0.

Use the trailing-slash form for the two legal URLs. Both canonicalise to it, and
entering the slashless form makes Apple's fetcher take a 301 hop for no reason.
