/**
 * Provenance rendering for recall/reflect output (hindsight_recall /
 * hindsight_reflect tools).
 *
 * Pure functions over the server's RecallResult / ReflectResponse shapes.
 * Every rendered fact carries a compact provenance line (id / document_id /
 * context snippet / observation_scopes) so agents can judge a memory's
 * trustworthiness instead of treating all recall as equally authoritative.
 * Never emits raw JSON.
 */

import type { RecallResult, ReflectResponse } from "@vectorize-io/hindsight-client";

/**
 * ReflectFact is NOT exported by the SDK (dist/index.d.ts exports only
 * ReflectRequest/ReflectResponse) — derive it from ReflectResponse so the
 * renderer types against the real response shape.
 */
type ReflectFact = NonNullable<NonNullable<ReflectResponse["based_on"]>["memories"]>[number];

/** Flatten a string to a single line and cap it at maxChars. */
function snippet(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars)}...`;
}

/**
 * Extract observation scopes from a result's metadata. The stored value can be
 * a JSON-serialized string[][] (flattened one level — a flat join of nested
 * arrays would render "[object Object]"), a JSON string array, a
 * comma-separated string, a single mode string ('per_tag' | 'combined' |
 * 'all_combinations' | 'shared'), or absent. Callers cap the list.
 */
function extractScopes(metadata: RecallResult["metadata"]): string[] {
  const raw = metadata?.observation_scopes;
  if (raw === undefined || raw === null || raw === "") return [];
  const trimmed = raw.trim();
  let scopes: string[] = [];
  let jsonParsed = false;
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        jsonParsed = true;
        scopes = parsed.flatMap((entry) =>
          Array.isArray(entry) ? entry.map(String) : [String(entry)]
        );
      }
    } catch {
      // Not valid JSON — fall through to the comma/single fallback.
    }
  }
  // A successfully parsed empty array means "no scopes" — do not fall
  // through and render the raw bracket text.
  if (scopes.length === 0 && !jsonParsed) {
    scopes = trimmed.includes(",")
      ? trimmed
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [trimmed];
  }
  return scopes;
}

export interface RenderRecallOptions {
  provenance: boolean;
}

/**
 * Render recall results as "N. <text>" blocks with a compact provenance line
 * per result: `[id: <id> | doc: <document_id or -> | ctx: <snippet ≤80 or -> |
 * scopes: <≤3 or ->]`. provenance: false renders only the numbered text (the
 * token-budget escape hatch; raw facts stay in the tool's details).
 */
export function renderRecallResults(results: RecallResult[], opts: RenderRecallOptions): string {
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.text}`];
      if (opts.provenance) {
        const doc = r.document_id ?? "-";
        const ctx = r.context ? snippet(r.context, 80) : "-";
        const allScopes = extractScopes(r.metadata);
        const scopes = allScopes.slice(0, 3);
        const scopesText =
          scopes.length > 0
            ? `${scopes.join(", ")}${allScopes.length > 3 ? ` +${allScopes.length - 3} more` : ""}`
            : "-";
        lines.push(`[id: ${r.id} | doc: ${doc} | ctx: ${ctx} | scopes: ${scopesText}]`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export interface RenderReflectSourcesOptions {
  provenance: boolean;
  /** Maximum source lines (default 10). */
  maxSources?: number;
}

/**
 * Render the reflect source-facts list: a "Sources:" header followed by one
 * line per source fact (id prefix, doc, first ~60 chars of text). ReflectFact
 * has no document_id (SDK type), so doc is always "-" — honest, not invented.
 * More than maxSources facts produce a "(N more sources)" note. Empty facts
 * (or provenance: false) return "" so callers append nothing.
 *
 * Note: renders based_on.memories only; based_on.mental_models and
 * based_on.directives are not rendered (documented gap).
 */
export function renderReflectSources(
  facts: ReflectFact[],
  opts: RenderReflectSourcesOptions
): string {
  if (!opts.provenance || facts.length === 0) return "";
  const max = opts.maxSources ?? 10;
  const lines = facts.slice(0, max).map((f) => {
    const id = f.id ? f.id.slice(0, 8) : "-";
    const text = snippet(f.text, 60);
    return `- ${id} | doc: - | ${text}`;
  });
  if (facts.length > max) {
    lines.push(`(${facts.length - max} more sources)`);
  }
  return `Sources:\n${lines.join("\n")}`;
}
