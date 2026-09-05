/**
 * Consolidation/operations rendering for the hindsight_consolidate tool.
 *
 * Pure functions over the server's operations responses (GET /operations,
 * POST /consolidate, POST /consolidation/recover). The operations endpoint
 * has no task_type filter, so consolidation ops are filtered client-side.
 */

/** One operation from GET /operations (narrowed to the fields the tool uses). */
export interface OperationItem {
  id: string;
  task_type: string;
  status: string;
  items_count: number;
  created_at: string;
  error_message?: string | null;
  retry_count?: number | null;
}

/** Raw server response for GET /operations. */
export interface OperationsListResponse {
  bank_id: string;
  /** Server-side status-filtered total (NOT task_type-filtered). */
  total: number;
  limit: number;
  offset: number;
  operations: OperationItem[];
}

/** Raw server response for POST /consolidate. */
export interface ConsolidationResponse {
  operation_id: string;
  /** True when an existing pending task was reused. */
  deduplicated?: boolean;
}

/** Raw server response for POST /consolidation/recover. */
export interface RecoverConsolidationResponse {
  retried_count: number;
}

/** The task type of consolidation operations. */
export const CONSOLIDATION_TASK_TYPE = "consolidation";

/**
 * Humanize an ISO timestamp as an age string: "just now", "Xm ago", "Xh ago",
 * "Xd ago". Future timestamps (clock skew) clamp to "just now".
 */
export function formatAge(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "unknown age";
  const diffMs = Math.max(0, now.getTime() - parsed);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RenderOperationsOptions {
  maxTokens: number;
  /** Reference time for age rendering (defaults to the current time). */
  now?: Date;
}

/**
 * Render operations as a compact one-line-per-operation list, token-budgeted.
 * Failed operations append their retry count and error snippet when present.
 * Dropped lines produce a `(truncated: N of M operations)` note where M is the
 * length of the list passed in (the client-side-filtered consolidation ops),
 * never the server's unfiltered total. Never emits raw JSON.
 */
export function renderOperations(ops: OperationItem[], opts: RenderOperationsOptions): string {
  if (ops.length === 0) {
    return "No pending or failed consolidation operations.";
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
  for (const op of ops) {
    const idPrefix = op.id.slice(0, 8);
    let line = `  ${idPrefix} ${op.task_type} ${op.status} ${formatAge(op.created_at, opts.now)}`;
    if (op.status === "failed") {
      if (op.retry_count != null) {
        line += ` (retries: ${op.retry_count})`;
      }
      if (op.error_message) {
        const snippet =
          op.error_message.length > 60 ? `${op.error_message.slice(0, 60)}...` : op.error_message;
        line += ` — ${snippet}`;
      }
    }
    if (!emit(line)) {
      break;
    }
    rendered += 1;
  }
  if (rendered < ops.length) {
    const note = `(truncated: ${rendered} of ${ops.length} operations)`;
    lines.push(note);
    budget -= estimateTokens(note);
  }
  return lines.join("\n");
}
