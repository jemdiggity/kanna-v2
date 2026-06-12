import type { AgentExecutionType } from "./agentExecutionType";

export function shouldPrewarmTaskShellOnCreate(agentType: AgentExecutionType): boolean {
  void agentType;
  return true;
}
