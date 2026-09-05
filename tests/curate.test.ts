/**
 * Unit tests for memory-curation rendering (hindsight_curate tool).
 *
 * Tests the real production function (renderMemories) against fixture data —
 * the same pattern as graph.test.ts / consolidation.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { type MemoryUnit, renderMemories } from "../src/curate";

const NOW = new Date("2026-09-05T12:00:00Z");

function makeMemories(): MemoryUnit[] {
  return [
    {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      text: "The dev VM runs Docker CE 29.4.0 with Compose.",
      state: "valid",
      date: "2026-09-02T12:00:00+00:00",
    },
    {
      id: "bbbbbbbb-1111-2222-3333-444444444444",
      text: "The old bank URL was http://10.100.0.100:8888.",
      state: "invalidated",
      date: "2026-08-18T13:34:51.115819+00:00",
      invalidated_at: "2026-09-04T10:00:00+00:00",
      invalidation_reason: "Bank URL moved to the new host",
    },
  ];
}

describe("renderMemories", () => {
  it("renders one line per memory with id prefix, state, age, and snippet", () => {
    const text = renderMemories(makeMemories(), { maxTokens: 1000, now: NOW });
    expect(text).toContain("aaaaaaaa valid");
    expect(text).toContain("The dev VM runs Docker CE 29.4.0 with Compose.");
    expect(text).toContain("bbbbbbbb invalidated");
  });

  it("annotates invalidated memories with their reason", () => {
    const text = renderMemories(makeMemories(), { maxTokens: 1000, now: NOW });
    expect(text).toContain("[reason: Bank URL moved to the new host]");
  });

  it("renders deterministic ages from the provided now", () => {
    const text = renderMemories(makeMemories(), { maxTokens: 1000, now: NOW });
    expect(text).toContain("3d ago");
  });

  it("returns 'No memories found.' for an empty list", () => {
    expect(renderMemories([], { maxTokens: 600 })).toBe("No memories found.");
  });

  it("truncates to the token budget with a (truncated: N of M) note", () => {
    const items: MemoryUnit[] = Array.from({ length: 10 }, (_, i) => ({
      id: `mem-${i}-0000-0000-0000-000000000000`,
      text: `Memory number ${i} with a reasonably long text snippet.`,
      state: "valid",
      date: "2026-09-01T00:00:00+00:00",
    }));
    const text = renderMemories(items, { maxTokens: 100, now: NOW });
    expect(text).toContain("(truncated:");
    expect(text).toContain("of 10 memories)");
  });
});
