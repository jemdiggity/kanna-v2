import { escapeTaskFileHtml } from "./taskFileSyntaxHighlight";

export type TaskDiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface TaskDiffLine {
  kind: TaskDiffLineKind;
  text: string;
}

export interface TaskDiffFileSection {
  path: string;
  additions: number;
  deletions: number;
  lines: TaskDiffLine[];
}

interface TaskDiffDocumentOptions {
  patch: string;
  baseRef: string | null;
  truncated: boolean;
}

const FILE_HEADER_PREFIX = "diff --git ";

const META_PREFIXES = [
  "index ",
  "--- ",
  "+++ ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "dissimilarity index",
  "copy from",
  "copy to",
  "rename from",
  "rename to",
  "Binary files ",
  "GIT binary patch",
  "\\ No newline at end of file"
];

function classifyLine(text: string): TaskDiffLineKind {
  if (text.startsWith("@@")) return "hunk";
  if (META_PREFIXES.some((prefix) => text.startsWith(prefix))) return "meta";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  return "context";
}

function stripPathPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * Extracts the display path from a `diff --git a/<old> b/<new>` header. Paths
 * with spaces stay intact because git quotes them or the a/-b/ midpoint is
 * unambiguous for equal paths; for the rare ambiguous rename the raw header
 * remains visible in the section body.
 */
function filePathFromHeader(header: string): string {
  const spec = header.slice(FILE_HEADER_PREFIX.length).trim();
  if (spec.startsWith('"')) {
    const closingQuote = spec.indexOf('"', 1);
    if (closingQuote > 0) {
      return stripPathPrefix(spec.slice(1, closingQuote));
    }
  }
  const midpoint = ` b/`;
  const midpointIndex = spec.lastIndexOf(midpoint);
  if (midpointIndex >= 0) {
    return spec.slice(midpointIndex + midpoint.length);
  }
  const parts = spec.split(" ");
  return stripPathPrefix(parts[parts.length - 1] ?? spec);
}

export function parseTaskDiffPatch(patch: string): TaskDiffFileSection[] {
  const sections: TaskDiffFileSection[] = [];
  let current: TaskDiffFileSection | null = null;

  for (const text of patch.split("\n")) {
    if (text.startsWith(FILE_HEADER_PREFIX)) {
      current = {
        path: filePathFromHeader(text),
        additions: 0,
        deletions: 0,
        lines: []
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const kind = classifyLine(text);
    if (kind === "add") current.additions += 1;
    if (kind === "del") current.deletions += 1;
    current.lines.push({ kind, text });
  }

  for (const section of sections) {
    while (
      section.lines.length > 0 &&
      section.lines[section.lines.length - 1].text === ""
    ) {
      section.lines.pop();
    }
  }

  return sections;
}

function renderSection(section: TaskDiffFileSection): string {
  const lines = section.lines
    .map(
      (line) =>
        `<span class="line ${line.kind}">${escapeTaskFileHtml(line.text)}\n</span>`
    )
    .join("");
  const stats = `<span class="stat-add">+${section.additions}</span> <span class="stat-del">−${section.deletions}</span>`;
  return `<section class="file">
  <header class="file-header"><span class="file-path">${escapeTaskFileHtml(section.path)}</span><span class="file-stats">${stats}</span></header>
  <pre class="diff">${lines}</pre>
</section>`;
}

export function buildTaskDiffDocument({
  patch,
  baseRef,
  truncated
}: TaskDiffDocumentOptions): string {
  const sections = parseTaskDiffPatch(patch);
  const summary =
    sections.length === 0
      ? `<p class="empty">No changes${baseRef ? ` compared to ${escapeTaskFileHtml(baseRef)}` : ""}.</p>`
      : `<p class="summary">${sections.length} changed ${sections.length === 1 ? "file" : "files"}${
          baseRef ? ` vs ${escapeTaskFileHtml(baseRef)}` : ""
        }</p>`;
  const truncationNotice = truncated
    ? `<p class="truncated">Diff is too large to display fully; showing the beginning.</p>`
    : "";
  const body = sections.map(renderSection).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #050b14; color: #d7e2f0; }
    body {
      padding: 14px 0 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    .summary, .empty, .truncated { margin: 0 16px 14px; color: #8292a9; font-size: 13px; }
    .empty { margin-top: 26px; text-align: center; }
    .truncated { border: 1px solid #4b3a20; border-radius: 8px; background: #201808; color: #e6c98a; padding: 10px 12px; }
    .file { border-top: 1px solid #1d2c43; margin-bottom: 4px; }
    .file-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      background: #0b1422;
      padding: 9px 16px;
      border-bottom: 1px solid #1d2c43;
    }
    .file-path {
      color: #e6edf7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: 12px;
      font-weight: 700;
      word-break: break-all;
    }
    .file-stats { flex-shrink: 0; font-size: 12px; font-weight: 700; }
    .stat-add { color: #a8e6a3; }
    .stat-del { color: #ff9f92; }
    .diff {
      margin: 0;
      padding: 8px 0 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
    }
    .line { display: block; padding: 0 16px; white-space: pre; }
    .line.add { background: rgba(63, 185, 80, 0.16); color: #b6f0b0; }
    .line.del { background: rgba(248, 81, 73, 0.16); color: #ffb3a8; }
    .line.hunk { background: #101a29; color: #73b7ff; margin: 6px 0; padding-top: 3px; padding-bottom: 3px; }
    .line.meta { color: #7f8da3; }
    .line.context { color: #aebbd0; }
  </style>
</head>
<body>
  ${summary}
  ${truncationNotice}
  ${body}
</body>
</html>`;
}
