import type { AuthState } from "../state/sessionStore";

export interface AccountBadgePresentation {
  initials: string;
  label: string;
  detail: string;
}

export function getAccountBadgePresentation(auth: AuthState): AccountBadgePresentation {
  if (auth.status === "signedIn" || auth.status === "signingIn" || auth.status === "error") {
    const user = auth.user;
    if (user) {
      const label = user.displayName ?? user.email ?? "Kanna Cloud";
      return {
        initials: getInitials(label),
        label,
        detail: user.email ?? "Signed in"
      };
    }
  }

  if (auth.status === "signingIn") {
    return {
      initials: "K",
      label: "Signing in",
      detail: "Kanna Cloud"
    };
  }

  if (auth.status === "error") {
    return {
      initials: "!",
      label: "Sign-in error",
      detail: auth.message
    };
  }

  return {
    initials: "K",
    label: "Sign in",
    detail: "Kanna Cloud"
  };
}

function getInitials(label: string): string {
  const parts = label
    .trim()
    .split(/[\s.@_-]+/)
    .filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "K";
}
