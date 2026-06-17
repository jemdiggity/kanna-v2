import { ref, watch, type Ref } from "vue";
import { invoke } from "../invoke";
import { fuzzyMatch } from "../utils/fuzzyMatch";

export type SlashCommandSource = "project" | "user" | "builtin";

export interface SlashCommand {
  /** Command name without the leading slash, e.g. "review". */
  name: string;
  /** Short, one-line description shown in the menu. */
  description: string;
  /** Where the command was defined. */
  source: SlashCommandSource;
}

/**
 * Built-in commands the agent CLI handles itself. These are verified to work in
 * headless stream-json mode (the CLI processes them and streams a result), so
 * they're passed through like any other input. Custom commands of the same name
 * override these.
 */
const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: "context", description: "Show token context usage", source: "builtin" },
  { name: "compact", description: "Summarize and compact the conversation", source: "builtin" },
  { name: "clear", description: "Clear the conversation history", source: "builtin" },
  { name: "cost", description: "Show session cost and token usage", source: "builtin" },
  { name: "usage", description: "Show plan usage limits", source: "builtin" },
  { name: "init", description: "Generate a CLAUDE.md for this project", source: "builtin" },
  { name: "review", description: "Review changes or a pull request", source: "builtin" },
];
// Deliberately excluded: /model, /help, /memory — these report "isn't
// available in this environment" in headless stream-json mode, so listing them
// would surface no-ops.

interface CommandDir {
  path: string;
  source: SlashCommandSource;
}

/**
 * Whether the provider's CLI actually expands slash commands in the headless
 * mode Kanna uses. Only Claude does: `codex exec` passes the prompt through
 * literally (verified), so a menu there would be misleading no-ops.
 */
function providerSupportsSlashCommands(provider: string | undefined): boolean {
  return (provider ?? "claude") === "claude";
}

function commandDirs(worktreePath: string | undefined, home: string): CommandDir[] {
  const dirs: CommandDir[] = [{ path: `${home}/.claude/commands`, source: "user" }];
  if (worktreePath) dirs.push({ path: `${worktreePath}/.claude/commands`, source: "project" });
  return dirs;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

/** Pull a one-line description from a command file's frontmatter or first prose line. */
export function parseCommandDescription(content: string): string {
  let body = content;
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (frontmatter) {
    const described = frontmatter[1].match(/^description:\s*(.+)$/m);
    if (described) return truncate(stripQuotes(described[1]));
    body = content.slice(frontmatter[0].length);
  }
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return firstLine ? truncate(firstLine) : "";
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function scanDir(dir: CommandDir): Promise<SlashCommand[]> {
  let names: string[];
  try {
    names = await invoke<string[]>("list_dir", { path: dir.path });
  } catch {
    // Directory absent — a normal case, not an error.
    return [];
  }
  const commands: SlashCommand[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".md")) continue;
    try {
      const content = await invoke<string>("read_text_file", { path: `${dir.path}/${fileName}` });
      commands.push({
        name: fileName.slice(0, -3),
        description: parseCommandDescription(content),
        source: dir.source,
      });
    } catch {
      continue;
    }
  }
  return commands;
}

/**
 * Discover the slash commands available to an agent session and filter them as
 * the user types, mirroring the Claude/Codex CLI command menus.
 */
export function useSlashCommands(
  provider: Ref<string | undefined>,
  worktreePath: Ref<string | undefined>,
) {
  const commands = ref<SlashCommand[]>([]);

  async function load(): Promise<void> {
    if (!providerSupportsSlashCommands(provider.value)) {
      commands.value = [];
      return;
    }
    let home = "";
    try {
      home = await invoke<string>("read_env_var", { name: "HOME" });
    } catch {
      home = "";
    }
    const dirs = commandDirs(worktreePath.value, home).filter((d) => d.path.startsWith("/"));
    const scanned = await Promise.all(dirs.map(scanDir));
    // Precedence (low → high): built-ins, user commands, project commands.
    const byName = new Map<string, SlashCommand>();
    for (const command of CLAUDE_BUILTINS) byName.set(command.name, command);
    for (const command of scanned.flat()) byName.set(command.name, command);
    commands.value = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  watch([provider, worktreePath], () => void load(), { immediate: true });

  function filter(query: string): SlashCommand[] {
    if (!query) return commands.value;
    return commands.value
      .map((command) => ({ command, score: fuzzyMatch(query, command.name)?.score ?? null }))
      .filter((entry): entry is { command: SlashCommand; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
  }

  return { commands, filter, reload: load };
}
