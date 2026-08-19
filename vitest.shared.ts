import { fileURLToPath } from "node:url";

/**
 * Test-runner options every workspace package shares.
 *
 * A dev machine routinely runs four to six Kanna worktrees at once, each with
 * its own suite and cargo builds — load averages around 20 are normal. Vitest's
 * defaults (5s per test, 10s per hook) are budgets for a quiet machine: on a
 * busy one they turn ordinary setup work into nondeterministic failures that
 * pass on rerun, which is exactly the noise that trains people to rerun rather
 * than read a failure.
 *
 * These ceilings are liveness bounds, not performance budgets. Nothing asserts
 * a duration against them: a test that genuinely hangs still fails, it just
 * takes longer to say so. Anything that really is measuring time must assert it
 * explicitly, relative to the work it is measuring — never by leaning on the
 * runner's timeout.
 *
 * Every package whose `test` script runs vitest must have a `vitest.config.ts`
 * that spreads `sharedTestOptions` into `test`; `tools/kd/tests/test-orchestration.test.ts`
 * enforces that.
 */
export const sharedTestOptions = {
  testTimeout: 60_000,
  hookTimeout: 60_000,
  // Raises `vi.waitFor`'s hard-coded 1s default for the same reason; see the
  // file itself. A package with its own setup files must append them to this
  // list rather than replace it.
  setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
} as const;
