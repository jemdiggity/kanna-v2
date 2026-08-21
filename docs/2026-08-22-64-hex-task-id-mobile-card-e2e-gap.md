# 64-hex task ID mobile-card E2E gap

The reported staging task was inspected on 2026-08-22 through the real account-relay route to desktop `desktop-aa43ab36-e634-4ae9-b629-e8c8a91f7bff`. Its `kanna-server` repository-task response preserved both the 64-hex task ID and the stored title, establishing that the title was not dropped by the cross-machine KSP/relay request.

Mobile currently creates 64-hex IDs through the supported create API, so an automated device flow can produce the affected data shape. The remaining E2E gap is visual: the failure was caused by the non-shrinking ID column consuming the title row, while the iOS accessibility tree still exposes both text nodes and therefore cannot prove that the title is visibly laid out rather than displaced. The existing Appium harness has no screenshot-baseline assertion for task-card geometry.

The narrower regression coverage therefore exercises both relevant boundaries:

- `apps/mobile/src/lib/firebase/taskIndex.test.ts` proves cloud publication mapping preserves the title beside a current 64-hex owner-local ID.
- `apps/mobile/src/components/TaskCard.test.tsx` renders the real card with that ID, proves the stored title remains present in a separate row from the width-constrained ID, and proves a blank title falls back to the prompt rather than the ID.

A full visual E2E becomes practical when the mobile Appium harness supports stable screenshot crops or another native layout probe that can assert the task title has nonzero visible bounds without overlapping the ID.
