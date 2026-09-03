export const ACCOUNT_DELETIONS_COLLECTION = "accountDeletions";

export class AccountDeletionInProgressError extends Error {
  constructor() {
    super("account deletion is in progress");
    this.name = "AccountDeletionInProgressError";
  }
}
