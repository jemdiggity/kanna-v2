import type { PipelineItem } from "../types/kanna";

/**
 * The workflow-name prefix Kanna binds when it claims an account-wide
 * singleton — a repo's Merge Master or Task Manager — through the relay
 * singleton directory.
 *
 * That name is the durable marker of directory-singleton identity: it is
 * written once at claim time, travels with the task row, and is republished as
 * `singletonAgent` on every cross-machine snapshot. A viewing machine can
 * therefore tell a singleton row apart without asking the directory, which is
 * what makes "pinned by default on every machine" a local decision rather than
 * a network round trip.
 */
export const SINGLETON_WORKFLOW_PREFIX = "singleton-";

/**
 * Where a defaulted singleton pin sorts. Pinned rows sort by `pin_order ?? 0`
 * ascending and explicit pin orders are assigned from 0 upwards, so a negative
 * order puts the singleton at the top of the pinned group without renumbering
 * — and so displacing — the operator's own pins.
 */
export const DEFAULT_SINGLETON_PIN_ORDER = -1;

export function singletonAgentFromWorkflowName(
  workflowName: string | null | undefined,
): string | null {
  if (!workflowName?.startsWith(SINGLETON_WORKFLOW_PREFIX)) return null;
  const agent = workflowName.slice(SINGLETON_WORKFLOW_PREFIX.length);
  return agent.length > 0 ? agent : null;
}

/** The row fields singleton identity is read from. */
export type SingletonIdentityItem = Pick<PipelineItem, "pipeline"> & {
  singleton_agent?: string | null;
};

/**
 * The agent a row is the account-wide singleton for, or `null` for an ordinary
 * task. A local row carries the synthetic workflow name; a cross-machine row
 * carries the owner's published `singleton_agent`, because the presentation
 * row minted for it does not reproduce the owner's workflow name.
 */
export function directorySingletonAgent(item: SingletonIdentityItem): string | null {
  return item.singleton_agent ?? singletonAgentFromWorkflowName(item.pipeline);
}

/**
 * Whether this machine pins the row by default. It is only a default: an
 * explicit pin or unpin always wins, on the owner's durable row and in the
 * viewer-local overlay alike.
 */
export function isDefaultPinnedTask(item: SingletonIdentityItem): boolean {
  return directorySingletonAgent(item) !== null;
}
