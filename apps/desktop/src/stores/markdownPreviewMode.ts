export type MarkdownPreviewMode = "raw" | "rendered";

export const MARKDOWN_PREVIEW_MODE_SETTING_KEY = "markdownPreviewMode";
export const DEFAULT_MARKDOWN_PREVIEW_MODE: MarkdownPreviewMode = "rendered";

export function normalizeMarkdownPreviewMode(
  value: string | null | undefined,
): MarkdownPreviewMode {
  return value === "raw" || value === "rendered"
    ? value
    : DEFAULT_MARKDOWN_PREVIEW_MODE;
}
