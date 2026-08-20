/**
 * Logging seam for the billing handlers.
 *
 * The handlers are exercised directly against the Firestore emulator by the
 * test suite, so they take a logger rather than importing the Cloud Functions
 * one — `src/index.ts` passes `firebase-functions/logger` when it wires them up.
 */
export interface BillingLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const consoleBillingLogger: BillingLogger = {
  info(message, context) {
    console.info(message, context ?? {});
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  error(message, context) {
    console.error(message, context ?? {});
  },
};
