export interface ClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  lines: Array<Record<string, unknown>>;
  duration: number;
}

const CLAUDE_UNAVAILABLE_PATTERNS = [
  "does not have access to Claude",
  "Please login again or contact your administrator.",
  "Failed to authenticate.",
  "Invalid authentication credentials",
];

export function isClaudeUnavailable(result: ClaudeResult): boolean {
  const resultLine = result.lines.find((line) => line.type === "result");
  if (!resultLine) {
    return false;
  }

  const output = resultLine.result;
  const apiErrorStatus = resultLine.api_error_status;
  const errorCode = resultLine.error;
  return (
    resultLine.is_error === true &&
    (
      apiErrorStatus === 401 ||
      errorCode === "authentication_failed" ||
      (
        typeof output === "string" &&
        CLAUDE_UNAVAILABLE_PATTERNS.some((pattern) => output.includes(pattern))
      )
    )
  );
}
