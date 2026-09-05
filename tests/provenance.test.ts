/**
 * Unit tests for recall/reflect provenance rendering (hindsight_recall /
 * hindsight_reflect tools).
 *
 * Tests the real production functions (renderRecallResults,
 * renderReflectSources) against deterministic fixtures — the same pattern as
 * graph.test.ts / consolidation.test.ts / curate.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { RecallResult } from "@vectorize-io/hindsight-client";
import { renderRecallResults, renderReflectSources } from "../src/provenance";

function makeResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    text: "The dev VM runs Docker CE 29.4.0 with Compose.",
    document_id: "019efc37-1fdd-7411-b5f7-dac95f7ef625",
    context: "pi: switch to main",
    metadata: {},
    ...overrides,
  };
}

describe("renderRecallResults", () => {
  it("renders numbered text with a provenance line per result", () => {
    const text = renderRecallResults([makeResult()], { provenance: true });
    expect(text).toContain("1. The dev VM runs Docker CE 29.4.0 with Compose.");
    expect(text).toContain(
      "[id: aaaaaaaa-1111-2222-3333-444444444444 | doc: 019efc37-1fdd-7411-b5f7-dac95f7ef625 | ctx: pi: switch to main | scopes: -]"
    );
  });

  it("renders - for absent document_id and context", () => {
    const text = renderRecallResults([makeResult({ document_id: null, context: null })], {
      provenance: true,
    });
    expect(text).toContain("doc: -");
    expect(text).toContain("ctx: -");
  });

  it("caps the context snippet at 80 chars and flattens newlines", () => {
    const text = renderRecallResults(
      [makeResult({ context: `line one\nline two ${"x".repeat(200)}` })],
      { provenance: true }
    );
    expect(text).toContain("ctx: line one line two ");
    expect(text).toContain("...");
    const ctxPart = text.split("ctx: ")[1]!.split(" | scopes")[0]!;
    expect(ctxPart.length).toBeLessThanOrEqual(83); // 80 chars + "..."
  });

  it("renders observation scopes from a JSON string array", () => {
    const text = renderRecallResults(
      [makeResult({ metadata: { observation_scopes: '["topic:a", "topic:b"]' } })],
      { provenance: true }
    );
    expect(text).toContain("scopes: topic:a, topic:b");
  });

  it("flattens a nested JSON string[][] one level", () => {
    const text = renderRecallResults(
      [makeResult({ metadata: { observation_scopes: '[["topic:a", "topic:b"], ["topic:c"]]' } })],
      { provenance: true }
    );
    expect(text).toContain("scopes: topic:a, topic:b, topic:c");
    expect(text).not.toContain("[object Object]");
  });

  it("renders a comma-separated scopes string", () => {
    const text = renderRecallResults(
      [makeResult({ metadata: { observation_scopes: "topic:a, topic:b" } })],
      { provenance: true }
    );
    expect(text).toContain("scopes: topic:a, topic:b");
  });

  it("renders a single mode string as one scope", () => {
    const text = renderRecallResults(
      [makeResult({ metadata: { observation_scopes: "per_tag" } })],
      { provenance: true }
    );
    expect(text).toContain("scopes: per_tag");
  });

  it("caps scopes at 3 with a +N more note", () => {
    const text = renderRecallResults(
      [makeResult({ metadata: { observation_scopes: '["a", "b", "c", "d"]' } })],
      { provenance: true }
    );
    const scopesPart = text.split("scopes: ")[1]!.split("]")[0]!;
    expect(scopesPart).toBe("a, b, c +1 more");
  });

  it("renders - for an empty JSON scopes array", () => {
    const text = renderRecallResults([makeResult({ metadata: { observation_scopes: "[]" } })], {
      provenance: true,
    });
    expect(text).toContain("scopes: -");
    expect(text).not.toContain("scopes: []");
  });

  it("handles null metadata", () => {
    const text = renderRecallResults([makeResult({ metadata: null })], { provenance: true });
    expect(text).toContain("scopes: -");
  });

  it("strips provenance lines when provenance is false", () => {
    const text = renderRecallResults([makeResult()], { provenance: false });
    expect(text).toBe("1. The dev VM runs Docker CE 29.4.0 with Compose.");
    expect(text).not.toContain("[id:");
  });
});

describe("renderReflectSources", () => {
  const facts = [
    { id: "aaaaaaaa-1111-2222-3333-444444444444", text: "The dev VM runs Docker CE 29.4.0." },
    { id: "bbbbbbbb-1111-2222-3333-444444444444", text: "The bank URL moved to a new host." },
  ];

  it("renders a Sources header with one line per fact (id prefix, doc, snippet)", () => {
    const text = renderReflectSources(facts, { provenance: true });
    expect(text).toContain("Sources:");
    expect(text).toContain("- aaaaaaaa | doc: - | The dev VM runs Docker CE 29.4.0.");
    expect(text).toContain("- bbbbbbbb | doc: - | The bank URL moved to a new host.");
  });

  it("renders - for a missing fact id", () => {
    const text = renderReflectSources([{ id: null, text: "No id fact." }], {
      provenance: true,
    });
    expect(text).toContain("- - | doc: - | No id fact.");
  });

  it("caps the source list at 10 with a (N more sources) note", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `mem-${i}-0000-0000-0000-000000000000`,
      text: `Source fact number ${i}.`,
    }));
    const text = renderReflectSources(many, { provenance: true });
    expect(text).toContain("(3 more sources)");
    expect(text).not.toContain("Source fact number 12.");
  });

  it("returns empty for no facts", () => {
    expect(renderReflectSources([], { provenance: true })).toBe("");
  });

  it("returns empty when provenance is false", () => {
    expect(renderReflectSources(facts, { provenance: false })).toBe("");
  });
});
