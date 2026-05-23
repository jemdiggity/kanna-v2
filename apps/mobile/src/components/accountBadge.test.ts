import { describe, expect, it } from "vitest";
import { getAccountBadgePresentation } from "./accountBadgePresentation";

describe("getAccountBadgePresentation", () => {
  it("prompts signed-out users to sign in from the avatar badge", () => {
    expect(getAccountBadgePresentation({ status: "signedOut" })).toEqual({
      initials: "K",
      label: "Sign in",
      detail: "Kanna Cloud"
    });
  });

  it("shows signed-in user initials and email", () => {
    expect(
      getAccountBadgePresentation({
        status: "signedIn",
        user: {
          uid: "user-1",
          email: "upvote.sieve.7t@icloud.com",
          displayName: "Jeremy Hale"
        }
      })
    ).toEqual({
      initials: "JH",
      label: "Jeremy Hale",
      detail: "upvote.sieve.7t@icloud.com"
    });
  });
});
