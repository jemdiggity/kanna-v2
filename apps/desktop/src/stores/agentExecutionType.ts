export type AgentExecutionType = "pty" | "agent";

export function normalizeAgentExecutionType(value: string | null | undefined): AgentExecutionType {
  return value === "agent" || value === "sdk" ? "agent" : "pty";
}
