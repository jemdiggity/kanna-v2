export type RemoteCompanionLinkResolution =
  | { kind: "companion" }
  | { kind: "ordinary"; url: string }
  | { kind: "invalid" };

export interface ResolveRemoteCompanionLinkInput {
  clickedUrl: string;
  sourceOrigin?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function authority(value: string): string | null {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? null;
}

function hasAllowedLoopbackAuthority(value: string): boolean {
  const candidate = authority(value);
  if (!candidate || candidate.includes("@")) return false;
  const match =
    /^(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)$/iu.exec(candidate);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function parseSourceOrigin(value: string | undefined): URL | null {
  if (!value || !hasAllowedLoopbackAuthority(value)) return null;
  const parsed = parseHttpUrl(value);
  if (
    !parsed ||
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed;
}

export function resolveRemoteCompanionLink(
  input: ResolveRemoteCompanionLinkInput,
): RemoteCompanionLinkResolution {
  const clicked = parseHttpUrl(input.clickedUrl);
  if (!clicked) return { kind: "invalid" };

  const source = parseSourceOrigin(input.sourceOrigin);
  if (
    source &&
    hasAllowedLoopbackAuthority(input.clickedUrl) &&
    clicked.origin === source.origin
  ) {
    return { kind: "companion" };
  }
  return { kind: "ordinary", url: clicked.href };
}
