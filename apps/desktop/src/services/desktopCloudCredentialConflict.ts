/**
 * Raised when Firestore refuses this desktop's `desktopCredentials/{desktopId}`
 * write. The rules (see `firestore.rules`) only let the account that already
 * owns the document rewrite it, plus anyone at all once that owner has revoked
 * it, so a refusal means the cloud copy of this desktop belongs to a different
 * account. Nothing this desktop can send will succeed until that account
 * releases it, which makes the failure a state to report rather than one to
 * retry against.
 *
 * Lives apart from `desktopCloudAssociation` so consumers that only need to
 * recognize the state do not pull in the Firestore SDK.
 */
export class DesktopCloudCredentialConflictError extends Error {
  readonly desktopId: string;

  constructor(desktopId: string, options?: { cause?: unknown }) {
    super(`desktop ${desktopId} is registered to a different cloud account`, options);
    this.name = "DesktopCloudCredentialConflictError";
    this.desktopId = desktopId;
  }
}

export function isDesktopCloudCredentialConflict(
  error: unknown,
): error is DesktopCloudCredentialConflictError {
  return error instanceof DesktopCloudCredentialConflictError;
}
