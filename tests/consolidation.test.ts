/**
 * Unit tests for consolidation/operations rendering (hindsight_consolidate tool).
 *
 * Tests the real production functions (formatAge, renderOperations) against
 * fixture data — the same pattern as graph.test.ts / recall.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { formatAge, type OperationItem, renderOperations } from "../src/consolidation";

const NOW = new Date("2026-09-05T12:00:00Z");

function makeOps(): OperationItem[] {
  return [
    {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      task_type: "consolidation",
      status: "pending",
      items_count: 0,
      created_at: "2026-08-18T13:34:51.115819+00:00",
    },
    {
      id: "bbbbbbbb-1111-2222-3333-444444444444",
      task_type: "consolidation",
      status: "failed",
      items_count: 12,
      created_at: "2026-09-04T10:00:00+00:00",
      error_message: "worker crashed mid-consolidation",
      retry_count: 2,
    },
    {
      id: "cccccccc-1111-2222-3333-444444444444",
      task_type: "batch_retain",
      status: "pending",
      items_count: 1,
      created_at: "2026-09-05T11:00:00+00:00",
    },
  ];
}

describe("formatAge", () => {
  it("renders just now for sub-minute ages", () => {
    expect(formatAge("2026-09-05T11:59:30+00:00", NOW)).toBe("just now");
  });

  it("renders minutes", () => {
    expect(formatAge("2026-09-05T11:48:00+00:00", NOW)).toBe("12m ago");
  });

  it("renders hours", () => {
    expect(formatAge("2026-09-05T07:00:00+00:00", NOW)).toBe("5h ago");
  });

  it("renders days", () => {
    expect(formatAge("2026-08-18T13:34:51+00:00", NOW)).toBe("17d ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(formatAge("2026-09-06T00:00:00+00:00", NOW)).toBe("just now");
  });

  it("renders unknown age for unparseable timestamps", () => {
    expect(formatAge("not-a-date", NOW)).toBe("unknown age");
  });
});

describe("renderOperations", () => {
  it("renders one line per operation with id prefix, status, and age", () => {
    const text = renderOperations(makeOps(), { maxTokens: 800, now: NOW });
    expect(text).toContain("aaaaaaaa consolidation pending 17d ago");
    expect(text).toContain("bbbbbbbb consolidation failed 1d ago");
  });

  it("annotates failed operations with retries and error snippet", () => {
    const text = renderOperations(makeOps(), { maxTokens: 800, now: NOW });
    expect(text).toContain("(retries: 2)");
    expect(text).toContain("worker crashed mid-consolidation");
  });

  it("truncates at the token budget with a note", () => {
    const text = renderOperations(makeOps(), { maxTokens: 20, now: NOW });
    expect(text).toContain("(truncated:");
    expect(text).toContain("of 3 operations)");
  });

  it("renders the empty message for an empty list", () => {
    expect(renderOperations([], { maxTokens: 800, now: NOW })).toBe(
      "No pending or failed consolidation operations."
    );
  });
});
