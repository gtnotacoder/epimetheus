/**
 * Memory-curation rendering for the hindsight_curate tool.
 *
 * Pure functions over the server's memory-list response (GET /memories/list).
 * The tool's write modes (invalidate/supersede/revert) are orchestrated in
 * tools.ts; this module only renders candidate lists.
 */

import { formatAge } from "./consolidation";

/** One memory unit from GET /memories/list (narrowed to the fields the tool uses). */
export interface MemoryUnit {
  id: string;
  text: string;
  state: string;
  date: string;
  invalidated_at?: string | null;
  invalidation_reason?: string | null;
  fact_type?: string | null;
  entities?: string | null;
}

/** Raw server response for GET /memories/list. */
export interface MemoryListResponse {
  items: MemoryUnit[];
  total: number;
  limit: number;
  offset: number;
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RenderMemoriesOptions {
  maxTokens: number;
  /** Reference time for age rendering (defaults to the current time). */
  now?: Date;
}

/**
 * Render memory candidates as a compact one-line-per-memory list,
 * token-budgeted. Invalidated memories show their state and reason snippet.
 * Dropped lines produce a `(truncated: N of M memories)` note where M is the
 * length of the list passed in. Never emits raw JSON.
 */
export function renderMemories(items: MemoryUnit[], opts: RenderMemoriesOptions): string {
  if (items.length === 0) {
    return "No memories found.";
  }

  const lines: string[] = [];
  let budget = opts.maxTokens;

  const emit = (line: string): boolean => {
    const cost = estimateTokens(line);
    if (budget - cost < 0) return false;
    lines.push(line);
    budget -= cost;
    return true;
  };

  let rendered = 0;
  for (const m of items) {
    const idPrefix = m.id.slice(0, 8);
    const snippet = m.text.length > 80 ? `${m.text.slice(0, 80)}...` : m.text;
    let line = `  ${idPrefix} ${m.state} ${formatAge(m.date, opts.now)} — ${snippet}`;
    if (m.state === "invalidated" && m.invalidation_reason) {
      const reason =
        m.invalidation_reason.length > 60
          ? `${m.invalidation_reason.slice(0, 60)}...`
          : m.invalidation_reason;
      line += ` [reason: ${reason}]`;
    }
    if (!emit(line)) {
      break;
    }
    rendered += 1;
  }
  if (rendered < items.length) {
    const note = `(truncated: ${rendered} of ${items.length} memories)`;
    lines.push(note);
    budget -= estimateTokens(note);
  }
  return lines.join("\n");
}
