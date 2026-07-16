import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const MAX_SYNTAX_HIGHLIGHT_CHARACTERS = 256 * 1024;
const MAX_SYNTAX_HIGHLIGHT_MARKUP_OVERHEAD = 64 * 1024;

const languageDefinitions = {
  bash,
  c,
  cpp,
  css,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml
} as const;

type TaskSyntaxLanguage = keyof typeof languageDefinitions;

for (const [name, definition] of Object.entries(languageDefinitions)) {
  hljs.registerLanguage(name, definition);
}

const BAZEL_FILENAMES = new Set([
  "BUILD",
  "BUILD.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel"
]);

const extensionLanguages: Record<string, TaskSyntaxLanguage> = {
  bash: "bash",
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash"
};

const fenceLanguages: Record<string, TaskSyntaxLanguage> = {
  ...extensionLanguages,
  cxx: "cpp",
  javascript: "javascript",
  markdown: "markdown",
  python: "python",
  rust: "rust",
  shell: "bash",
  typescript: "typescript"
};

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function escapeTaskFileHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

export function getTaskFileSyntaxLanguage(
  path: string
): TaskSyntaxLanguage | null {
  const name = baseName(path);
  if (BAZEL_FILENAMES.has(name) || name.endsWith(".bzl")) return "python";

  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return extensionLanguages[extension] ?? null;
}

export function getMarkdownFenceSyntaxLanguage(
  info: string
): TaskSyntaxLanguage | null {
  const label = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return fenceLanguages[label] ?? null;
}

function highlight(
  content: string,
  language: TaskSyntaxLanguage | null
): string {
  if (!language || content.length > MAX_SYNTAX_HIGHLIGHT_CHARACTERS) {
    return escapeTaskFileHtml(content);
  }

  try {
    const highlighted = hljs.highlight(content, {
      ignoreIllegals: true,
      language
    }).value;
    return highlighted.length <=
      content.length + MAX_SYNTAX_HIGHLIGHT_MARKUP_OVERHEAD
      ? highlighted
      : escapeTaskFileHtml(content);
  } catch {
    return escapeTaskFileHtml(content);
  }
}

export function highlightTaskFileSource(content: string, path: string): string {
  return highlight(content, getTaskFileSyntaxLanguage(path));
}

export function highlightMarkdownFence(content: string, info: string): string {
  return highlight(content, getMarkdownFenceSyntaxLanguage(info));
}
