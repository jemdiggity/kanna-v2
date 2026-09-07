import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test code must not reach a Kanna server through Node's global `fetch`.
 *
 * `kanna-server` classifies every request on its real listener
 * (`crates/kanna-server/src/http_api/lan_trust.rs`): one carrying `Origin` or
 * any `Sec-Fetch-*` header is browser-originated and must present the
 * desktop's local control credential. Node 24's `fetch` is undici, which
 * attaches `Sec-Fetch-Mode` to every request, so a harness that is an ordinary
 * local process gets refused 403 — and the 403 surfaces as a readiness loop
 * that never settles, a suite that "hangs", or a bare `403` with no hint of
 * why. That defect was diagnosed and patched four separate times in one week
 * before anyone named the class.
 *
 * The fix is `@kanna/local-process-fetch`. This contract keeps the class dead:
 * a new bare `fetch` at a Kanna URL fails here instead of eight hours into
 * someone else's debugging session.
 *
 * ## What it can and cannot see
 *
 * This is a source scan, not a type-aware analysis (the repo has no ESLint
 * lane; `realSuiteNaming.test.ts` is the precedent for a contract enforced by
 * reading sources). It flags a bare `fetch(` whose argument text names a Kanna
 * route — the route segments are re-derived from the Rust sources on every
 * run, so a new endpoint is covered the day it lands — or a base-URL
 * identifier only a Kanna base ever uses.
 *
 * It therefore cannot see a call whose URL is entirely dynamic, e.g. a
 * `FetchLike` adapter that forwards an opaque `input`. Those are real and this
 * check will not catch them; when you write one, hand it `localProcessFetch`
 * rather than `fetch`.
 *
 * Calls to genuinely foreign services keep the global `fetch` — WebDriver,
 * Firebase emulators (whose paths are `/v1/projects/...`, not a Kanna route),
 * Appium, Metro, the relay, App Store Connect. Nothing there reads fetch
 * metadata.
 *
 * A call that must stay a browser fetch — code running inside the desktop
 * webview, which is a real browser and presents the credential — declares
 * itself with a `local-fetch-exempt:` comment giving the reason, on the call's
 * line or the line above.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** Directories whose HTTP calls this contract governs. */
const SCANNED_DIRECTORIES = [
  "apps/desktop/tests",
  "apps/mobile/e2e",
  "tests",
  "tools/kd/src",
  "tools/kd/tests",
];

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist", ".build", ".turbo"]);

/** This file quotes the patterns it bans, so it cannot scan itself. */
const SELF = "tools/kd/tests/kanna-test-fetch.contract.test.ts";

const EXEMPTION_MARKER = "local-fetch-exempt:";

/**
 * Files whose migration is already in flight in another task, so this task must
 * not also edit them. Each entry is a promise to delete the entry, not a
 * permanent carve-out: the assertion below fails when a listed file has stopped
 * violating the contract, which is what makes these expire on merge rather than
 * quietly becoming precedent.
 */
const PENDING_MIGRATIONS: Record<string, string> = {
  "apps/desktop/tests/e2e/real/local-transfer-headless-engine.test.ts":
    "task b08e50ff (transfer-suite serverSql/waitForSql migration, in revision)",
  "apps/desktop/tests/e2e/real/pty-runtime-status.test.ts":
    "task ef8edab4 (runtime-status helper migration, in review)",
};

/**
 * Base-URL identifiers that only ever name a Kanna server. Deliberately not
 * the bare word `baseUrl`: WebDriver clients spell theirs `getBaseUrl()` and
 * `this.baseUrl`, and flagging those would train people to add exemptions.
 */
const KANNA_BASE_IDENTIFIERS = [
  "lanBaseUrl",
  "serverBaseUrl",
  "kannaBaseUrl",
  "desktopServerBaseUrl",
  "KANNA_MOBILE_SERVER_PORT",
];

/**
 * First path segments of every `/v1/` and `/v2/` route `kanna-server` serves,
 * read from the Rust sources so this list cannot drift from the router.
 */
function kannaRouteSegments(): Set<string> {
  const segments = new Set<string>();
  for (const file of sourceFilesUnder(resolve(repoRoot, "crates/kanna-server/src"), [".rs"])) {
    const source = readFileSync(file, "utf8");
    for (const [, segment] of source.matchAll(/"\/v[12]\/([A-Za-z][A-Za-z0-9_-]*)/g)) {
      segments.add(segment);
    }
  }
  return segments;
}

function sourceFilesUnder(directory: string, extensions: string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORY_NAMES.has(entry.name) ? [] : sourceFilesUnder(path, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/**
 * The text passed to a call whose `(` sits at `openIndex`, read by matching
 * parentheses so a multi-line call is captured whole and the statement after
 * it is not.
 */
function callArguments(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isExempt(source: string, index: number): boolean {
  const lines = source.slice(0, index).split("\n");
  const currentLineStart = source.lastIndexOf("\n", index - 1) + 1;
  const currentLineEnd = source.indexOf("\n", index);
  const currentLine = source.slice(currentLineStart, currentLineEnd === -1 ? undefined : currentLineEnd);
  const previousLine = lines.length >= 2 ? lines[lines.length - 2] : "";
  return [currentLine, previousLine].some((line) => {
    const marker = line.indexOf(EXEMPTION_MARKER);
    return marker !== -1 && line.slice(marker + EXEMPTION_MARKER.length).trim().length > 0;
  });
}

export interface BareKannaFetch {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

/**
 * Every bare-`fetch`-at-a-Kanna-URL call in `source`. Exported so the
 * detector's own behaviour is pinned by fixtures below rather than only by the
 * repository happening to be clean.
 */
export function findBareKannaFetches(
  file: string,
  source: string,
  routeSegments: Set<string>,
): BareKannaFetch[] {
  const findings: BareKannaFetch[] = [];
  // `(?<![.\w$])` skips `localProcessFetch(`, `nodeFetch(` and `client.fetch(`;
  // only the global is in scope.
  for (const match of source.matchAll(/(?<![.\w$])fetch\s*\(/g)) {
    const openIndex = match.index + match[0].length - 1;
    const argumentText = callArguments(source, openIndex);
    const reason = kannaTarget(argumentText, routeSegments);
    if (!reason) continue;
    if (isExempt(source, match.index)) continue;
    findings.push({
      file,
      line: lineNumberAt(source, match.index),
      reason,
      snippet: argumentText.replace(/\s+/g, " ").trim().slice(0, 120),
    });
  }

  // The global handed to something else as its HTTP client. This is how the
  // class hid in `apps/mobile/e2e/agentProviderInventory.integration.test.tsx`
  // — `createLanTransport(baseUrl, fetch)` names no URL at all, so the check
  // above cannot see it, and every call the transport then made was refused
  // 403. Injecting an HTTP client in a harness means `localProcessFetch`; a
  // foreign service says so with an exemption.
  for (const match of source.matchAll(/[(,]\s*fetch\s*(?=[,)])/g)) {
    const index = match.index + match[0].indexOf("fetch");
    if (isExempt(source, index)) continue;
    findings.push({
      file,
      line: lineNumberAt(source, index),
      reason: "hands the global fetch to another client as its HTTP transport",
      snippet: source.slice(index - 60 < 0 ? 0 : index - 60, index + 20).replace(/\s+/g, " ").trim(),
    });
  }

  return findings;
}

function kannaTarget(argumentText: string, routeSegments: Set<string>): string | null {
  for (const [, path, segment] of argumentText.matchAll(/(\/v[12]\/([A-Za-z][A-Za-z0-9_-]*))/g)) {
    if (routeSegments.has(segment)) return `targets the Kanna route ${path}`;
  }
  const identifier = KANNA_BASE_IDENTIFIERS.find((name) => argumentText.includes(name));
  return identifier ? `builds its URL from ${identifier}` : null;
}

describe("Kanna server calls from test code", () => {
  const routeSegments = kannaRouteSegments();

  it("derives the route vocabulary from the server sources", () => {
    // If the router moves and this comes back empty, the contract below would
    // pass by seeing nothing — so fail loudly here instead.
    expect(routeSegments.size).toBeGreaterThan(10);
    expect(routeSegments).toContain("tasks");
    expect(routeSegments).toContain("status");
    expect(routeSegments).toContain("settings");
  });

  it("catches the desktop-server-phase3 pattern", () => {
    const source = [
      "const response = await fetch(`${await serverBaseUrl(client)}/v1/settings/selected_repo_id`);",
      "expect(response.status).toBe(200);",
    ].join("\n");

    expect(findBareKannaFetches("sample.test.ts", source, routeSegments)).toEqual([
      expect.objectContaining({ line: 1, reason: "targets the Kanna route /v1/settings" }),
    ]);
  });

  it("leaves foreign services, the shared client, and declared exemptions alone", () => {
    const source = [
      "await fetch(`http://127.0.0.1:${port}/v1/projects/kanna-local/databases/(default)/documents/${path}`);",
      "await fetch(`http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`);",
      "await fetch(`${client.getBaseUrl()}/session/${sessionId}/window`);",
      "await fetch(`${ascBaseUrl}/v1/apps/${appId}/appStoreVersions`);",
      "await localProcessFetch(`${harness.lanBaseUrl}/v1/tasks/recent`);",
      "// local-fetch-exempt: runs in the desktop webview, which presents the credential",
      "await fetch(`${base}/v1/tasks/${id}/actions/advance-stage`, { method: 'POST' });",
    ].join("\n");

    expect(findBareKannaFetches("sample.test.ts", source, routeSegments)).toEqual([]);
  });

  it("catches the global fetch handed to another client", () => {
    const source = "const client = createKannaClient(createLanTransport(baseUrl, fetch));";

    expect(findBareKannaFetches("sample.test.ts", source, routeSegments)).toEqual([
      expect.objectContaining({
        line: 1,
        reason: "hands the global fetch to another client as its HTTP transport",
      }),
    ]);
  });

  it("does not mistake a quoted or typed `fetch` for an injected one", () => {
    const source = [
      'vi.stubGlobal("fetch", vi.fn());',
      "const impl = fetchImpl as typeof fetch;",
      'await runner.run("git", ["fetch", "origin", "main"]);',
    ].join("\n");

    expect(findBareKannaFetches("sample.test.ts", source, routeSegments)).toEqual([]);
  });

  it("requires an exemption to state a reason", () => {
    const source = [
      "// local-fetch-exempt:",
      "await fetch(`${base}/v1/snapshot`);",
    ].join("\n");

    expect(findBareKannaFetches("sample.test.ts", source, routeSegments)).toHaveLength(1);
  });

  const allFindings = SCANNED_DIRECTORIES.flatMap((directory) =>
    sourceFilesUnder(resolve(repoRoot, directory), SCANNED_EXTENSIONS).flatMap((path) => {
      const file = relative(repoRoot, path);
      if (file === SELF) return [];
      return findBareKannaFetches(file, readFileSync(path, "utf8"), routeSegments);
    }),
  );

  it("routes every Kanna server call through @kanna/local-process-fetch", () => {
    const findings = allFindings.filter((finding) => !(finding.file in PENDING_MIGRATIONS));

    expect(
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason} — ${finding.snippet}`),
      "Node's global fetch sends Sec-Fetch-* headers, which kanna-server refuses with 403. " +
        "Import { localProcessFetch } from \"@kanna/local-process-fetch\", or declare a " +
        "`local-fetch-exempt: <reason>` comment if the call must stay a browser fetch.",
    ).toEqual([]);
  });

  it("expires each pending migration as soon as its owner lands", () => {
    const violating = new Set(allFindings.map((finding) => finding.file));
    const settled = Object.entries(PENDING_MIGRATIONS)
      .filter(([file]) => !violating.has(file))
      .map(([file, owner]) => `${file} — ${owner}`);

    expect(
      settled,
      "These files no longer call a Kanna server through the global fetch. Delete their " +
        "PENDING_MIGRATIONS entries so the contract covers them.",
    ).toEqual([]);
  });
});
