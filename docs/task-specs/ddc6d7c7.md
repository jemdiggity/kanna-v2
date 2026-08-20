# ddc6d7c7 — Colour task cards by workflow stage, from the icon

## Goal

Owner request, 2026-08-19: "the workflow stage sets the task card's color.
Let's use our icon's colours as a theme. The mobile app is a little boring
currently."

A **spike**: something the owner can feel on his phone and react to, not a
design-system overhaul. The task list was a wall of identical navy cards —
stage lived only in a grey pill, so scrolling told you nothing until you read
each row.

## Palette

Sampled from `apps/mobile/assets/icon.png` (1024x1024), which is itself a stack
of rounded task pills. All nine appear verbatim in the PNG — each was checked
against the image's full pixel set, not just the pixel it was read from. (The
round-1 reviewer measured `violet #4D35B4` as within 1/255; that is consistent
with comparing against a neighbouring pixel of the gradient it sits in, since
the exact value does occur.)

| Name | Hex | Where in the icon |
|---|---|---|
| orange | `#FF8C14` | top row, right end of the long pill |
| rose | `#FB426E` | top row, left end |
| pink | `#F83087` | second row, right end |
| fuchsia | `#D921B3` | second row, left end |
| purple | `#A32ADB` | third row, flat — the icon's most-used saturated colour |
| violet | `#4D35B4` | fourth row, right end |
| blue | `#144EB6` | bottom row, left end |
| green | `#14DE53` | the lone dot, top right |
| slate | `#786E8F` | bottom row, right end, where the gradient runs out |

## Stage -> palette entry

| Stage | Entry |
|---|---|
| `in progress` | orange |
| `review` | purple |
| `pr` | green |
| `consultation` | blue |
| unknown / empty | slate |
| any custom repo stage | hashed by name over pink, fuchsia, violet, rose |
| `blocked` | rose, as an overlay on whatever stage the task sits in |

A custom stage is coloured rather than greyed: greying would read as broken on
exactly the workflows a repo cared enough to write. Slate is reserved for "no
stage reported".

## Treatment

- 6px left edge in the accent, at full strength.
- Card surface tinted the same hue.
- Stage chip tinted to match, with a lifted label.
- Pinned rows wear the same hue at full strength on their 1px outline, against
  the muted stage border an unpinned row wears. Stage and pin stay orthogonal:
  hue is the stage, brightness is the pin, so PR #1126's outline still reads.
- The `TaskScreen` header chip wears the same treatment, so opening a task does
  not drop the signal that led the eye to it.

Everything is derived from one accent in
`apps/mobile/src/theme/taskStageTheme.ts`, so iterating on owner feedback —
which is expected — stays a one-file change.

## Scope

In:

- The theme module, `TaskCard`, and the `TaskScreen` header. `TaskCard` is the
  single row component behind the task list, Activity and search, so one change
  covers all three surfaces.
- Component tests for the mapping and the contrast bar.

Out:

- Light-appearance work. The app is dark-only: no `useColorScheme` or
  `Appearance` anywhere in `apps/mobile/src`.
- E2E. The spike's stated bar is component tests, and this is pure colour
  computation.
- Any closed-task treatment: `TaskSummary` carries no `closedAt`, so mobile's
  lists never render one.
- Anything outside mobile, and any change to native code or config — the diff
  is JS-only and stays OTA-deliverable at `runtimeVersion` 2.1.4.

## Done when

- Every stage resolves to its palette entry, an unknown stage falls back
  safely, and text clears WCAG AA on every tinted surface.
- `pnpm --dir apps/mobile run typecheck` and `pnpm --dir apps/mobile run test`.

## Changes to the terms

- **Mid-task, 2026-08-19:** test on the **dev** environment, not staging;
  nothing to ship to the staging OTA channel before the owner approves the
  visuals. Then: run it on the physical iPhone 15 over WiFi via `kd`, verifying
  the device by name/UDID first, because the iPhone XR
  (`00008020-000869440228003A`) must not be touched. Then, after the owner saw
  the app: point it at staging instead. All honoured; nothing was published to
  any OTA channel, and both device installs were local.
- **Review round 1.** Two required fixes, both accepted and implemented: this
  spec file, whose `docs/task-specs/` convention landed on main after this
  branch forked; and a contrast regression the tint introduced in the repo
  label on the Activity list (`#7E93B4` fell to 4.01:1 on the `pr` surface and
  4.28:1 on `in progress`, against AA's 4.5:1 for 12px bold). The label is now
  stage-derived like the chip label, clearing 5.60:1 at worst across the whole
  palette, and the existing contrast test sweeps every `KANNA_ICON_PALETTE`
  entry so a future palette edit cannot reintroduce it.
