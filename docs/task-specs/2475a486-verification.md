# Revised iOS Simulator verification for 2475a486

Verified on 2026-08-23 in the task's iPhone 17 Pro simulator. The revised mobile bundle ran through the canonical `./kd mobile up --build dev --owner staging --cloud staging` flow against the staging owner and task `2475a486`. The temporary Simulator connection/trust setup used to reach that owner was removed from the worktree before final checks.

The captures below were all made after the final responder routing change: start capture lives at the ancestor boundary that can preempt the native WebView, but its predicate requires an open file preview, a touch below the measured preview-body boundary, and the 44-point left-edge band. Directory gestures still begin through move capture.

## Required swipe scenarios

| Evidence | Technique | Observation |
|---|---|---|
| [Below-threshold release](2475a486-screenshots/a-below-threshold-settled-revised.png) | Real W3C left-edge touch on the `packages/core` directory body, moved 40 points and released; screenshot after a two-second settle. | `packages/core` remains exactly full-width at zero. The header and rows are aligned and there is no dead gutter. |
| [Forward swipe with no history](2475a486-screenshots/b-forward-no-history-settled-revised.png) | Real W3C right-edge touch in blank directory space, moved 125 points left and released with an empty forward stack; screenshot after a two-second settle. | `packages/core` remains the current full-width directory at zero, with no navigation, offset, or gutter. |
| [Preview back mid-drag](2475a486-screenshots/c-preview-back-mid-drag-revised.png) | One real W3C gesture started at the left edge over the `packages/core/package.json` WebView, moved to 285 points, paused for three seconds, and was photographed while the pointer remained down. | The outgoing preview is visibly translated right while the prior `packages/core` list slides in underneath. This proves the ancestor capture boundary preempted the WebView and uses the directory-back animation. |
| [Preview back settled](2475a486-screenshots/c-preview-back-settled-revised.png) | The same held gesture released after the mid-drag capture; screenshot after a two-second settle. | Navigation completes on the full-width `packages/core` file list with no resting offset or gutter. |
| [Directory back settled](2475a486-screenshots/d-directory-back-settled-revised.png) | Real W3C left-edge directory gesture moved 183 points and released; screenshot after a two-second settle. | Ordinary directory navigation completes from `packages/core` to `packages`, full-width and at zero. |

## Header hit-area routing

The Simulator reports Back at logical `x=14..51, y=84..103` and Close at `x=346..388, y=84..103` on a 402-point-wide screen. Direct W3C taps exercised both ends of each visible label:

| Evidence | Tap and result |
|---|---|
| [Back right edge](2475a486-screenshots/e-back-right-edge-tap-revised.png) | `x=50, y=94` navigated from `packages` to the task-worktree root. |
| [Back left edge](2475a486-screenshots/e-back-left-edge-tap-revised.png) | `x=15, y=94` navigated from `packages` to the task-worktree root after reopening that directory. |
| [Close left edge](2475a486-screenshots/f-close-left-edge-tap-revised.png) | `x=347, y=94` dismissed the explorer and exposed task detail. |
| [Close right edge](2475a486-screenshots/f-close-right-edge-tap-revised.png) | `x=387, y=94` dismissed a freshly reopened explorer and exposed task detail. |

Every linked screenshot was inspected at full size. All settled frames are aligned at zero with no clipped resting view or dead gutter; both Back extremes navigate, both Close extremes dismiss, and ordinary directory rows remained tappable while setting up these scenarios.
