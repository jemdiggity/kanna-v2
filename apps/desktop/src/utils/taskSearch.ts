export interface TaskSearchResult {
  score: number;
}

export interface TaskSearchable {
  id?: string | null;
  task_id?: string | null;
  display_name: string | null;
  issue_title: string | null;
  branch: string | null;
  prompt: string | null;
}

interface SearchField {
  text: string;
  weight: number;
}

const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const ASCII_ALNUM_RE = /^[a-z0-9]+$/i;
const DURABLE_TASK_ID_RE = /^[0-9a-f]{8}$/i;

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(TOKEN_SPLIT_RE)
    .filter((token) => token.length > 0);
}

function allowsSubstringMatch(term: string): boolean {
  return ASCII_ALNUM_RE.test(term) ? term.length >= 3 : term.length >= 2;
}

function scoreTermAgainstField(term: string, field: SearchField): number {
  const normalizedField = normalizeText(field.text);
  if (!normalizedField) return 0;

  const tokens = tokenize(field.text);
  const exactToken = tokens.find((token) => token === term);
  if (exactToken) {
    return Math.round(140 * field.weight);
  }

  const prefixToken = tokens.find((token) => token.startsWith(term));
  if (prefixToken) {
    return Math.round((110 - Math.min(prefixToken.length - term.length, 20)) * field.weight);
  }

  if (allowsSubstringMatch(term)) {
    const substringToken = tokens.find((token) => token.includes(term));
    if (substringToken) {
      return Math.round((75 - Math.min(substringToken.indexOf(term), 20)) * field.weight);
    }
  }

  if (normalizedField.startsWith(term)) {
    return Math.round(100 * field.weight);
  }

  if (allowsSubstringMatch(term) && normalizedField.includes(term)) {
    return Math.round(60 * field.weight);
  }

  return 0;
}

function searchableFields(item: TaskSearchable): SearchField[] {
  const taskId = item.task_id ?? item.id ?? "";
  return [
    { text: DURABLE_TASK_ID_RE.test(taskId) ? taskId : "", weight: 1.5 },
    { text: item.display_name ?? "", weight: 1.35 },
    { text: item.issue_title ?? "", weight: 1.2 },
    { text: item.branch ?? "", weight: 1.1 },
    { text: item.prompt ?? "", weight: 0.8 },
  ].filter((field) => field.text.trim().length > 0);
}

export function taskSearchMatch(query: string, item: TaskSearchable): TaskSearchResult | null {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;

  const terms = tokenize(query);
  if (terms.length === 0) return null;

  const fields = searchableFields(item);
  if (fields.length === 0) return null;

  let score = 0;
  for (const term of terms) {
    let bestTermScore = 0;
    for (const field of fields) {
      bestTermScore = Math.max(bestTermScore, scoreTermAgainstField(term, field));
    }
    if (bestTermScore === 0) return null;
    score += bestTermScore;
  }

  for (const field of fields) {
    const normalizedField = normalizeText(field.text);
    if (normalizedField === normalizedQuery) {
      score += Math.round(220 * field.weight);
      break;
    }
    if (normalizedField.startsWith(normalizedQuery)) {
      score += Math.round(150 * field.weight);
      break;
    }
    if (allowsSubstringMatch(normalizedQuery) && normalizedField.includes(normalizedQuery)) {
      score += Math.round(100 * field.weight);
      break;
    }
  }

  return { score };
}
