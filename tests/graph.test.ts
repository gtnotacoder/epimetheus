/**
 * Unit tests for entity-graph traversal and rendering (hindsight_graph tool).
 *
 * Tests the real production functions (traverseEntityGraph, resolveSeedInGraph,
 * renderEntityGraph) against fixture graph data — the same pattern as
 * recall.test.ts's formatRecallMessage tests.
 */

import { describe, expect, it } from "bun:test";
import {
  type EntityGraphResponse,
  renderEntityGraph,
  resolveSeedInGraph,
  traverseEntityGraph,
} from "../src/graph";

// Fixture graph: a small co-occurrence window.
//   pi -[cooccurrence]-> assistant (w=3184)
//   pi -[cooccurrence]-> user (w=2816)
//   assistant -[cooccurrence]-> user (w=2000)
//   user -[cooccurrence]-> vim (w=500)
//   vim -[cooccurrence]-> neovim (w=100)
function makeGraph(): EntityGraphResponse {
  return {
    nodes: [
      { data: { id: "pi", label: "pi", mentionCount: 7566 } },
      { data: { id: "assistant", label: "assistant", mentionCount: 3184 } },
      { data: { id: "user", label: "user", mentionCount: 2816 } },
      { data: { id: "vim", label: "vim", mentionCount: 900 } },
      { data: { id: "neovim", label: "neovim", mentionCount: 300 } },
    ],
    edges: [
      {
        data: {
          id: "e1",
          source: "pi",
          target: "assistant",
          linkType: "cooccurrence",
          weight: 3184,
        },
      },
      { data: { id: "e2", source: "pi", target: "user", linkType: "cooccurrence", weight: 2816 } },
      {
        data: {
          id: "e3",
          source: "assistant",
          target: "user",
          linkType: "cooccurrence",
          weight: 2000,
        },
      },
      { data: { id: "e4", source: "user", target: "vim", linkType: "cooccurrence", weight: 500 } },
      {
        data: { id: "e5", source: "vim", target: "neovim", linkType: "cooccurrence", weight: 100 },
      },
    ],
    total_entities: 5,
    total_edges: 5,
    limit: 5,
  };
}

describe("resolveSeedInGraph", () => {
  it("resolves a seed by id", () => {
    const result = resolveSeedInGraph(makeGraph(), "pi");
    expect(result?.node.id).toBe("pi");
    expect(result?.ambiguous).toBe(false);
  });

  it("resolves a seed by label case-insensitively", () => {
    const result = resolveSeedInGraph(makeGraph(), "PI");
    expect(result?.node.id).toBe("pi");
  });

  it("returns null for an unknown seed", () => {
    expect(resolveSeedInGraph(makeGraph(), "unknown")).toBeNull();
  });

  it("picks the most-mentioned node and flags ambiguity on duplicate labels", () => {
    const graph = makeGraph();
    graph.nodes.push({ data: { id: "pi2", label: "pi", mentionCount: 10 } });
    // Uppercase seed skips the exact id match and hits the label match.
    const result = resolveSeedInGraph(graph, "PI");
    expect(result?.node.id).toBe("pi");
    expect(result?.ambiguous).toBe(true);
  });
});

describe("traverseEntityGraph", () => {
  it("returns hops with typed edges from the seed", () => {
    const hops = traverseEntityGraph(makeGraph(), "pi", 2, 20);
    expect(hops).toHaveLength(2);
    // Hop 1: pi's two neighbors, highest weight first.
    expect(hops[0]).toEqual([
      { from: "pi", to: "assistant", linkType: "cooccurrence", weight: 3184 },
      { from: "pi", to: "user", linkType: "cooccurrence", weight: 2816 },
    ]);
    // Hop 2: assistant->user (user already visited, so only vim via user).
    expect(hops[1]).toEqual([{ from: "user", to: "vim", linkType: "cooccurrence", weight: 500 }]);
  });

  it("caps new nodes per hop at breadth", () => {
    const hops = traverseEntityGraph(makeGraph(), "pi", 2, 1);
    expect(hops[0]).toHaveLength(1);
    expect(hops[0]![0]!.to).toBe("assistant");
    // Hop 2 from assistant: user is the only unvisited neighbor.
    expect(hops[1]).toEqual([
      { from: "assistant", to: "user", linkType: "cooccurrence", weight: 2000 },
    ]);
  });

  it("caps traversal at depth", () => {
    const hops = traverseEntityGraph(makeGraph(), "pi", 1, 20);
    expect(hops).toHaveLength(1);
  });

  it("returns empty hops when the seed is not in the fetched window", () => {
    expect(traverseEntityGraph(makeGraph(), "missing", 2, 20)).toEqual([]);
  });

  it("does not revisit nodes across hops", () => {
    const hops = traverseEntityGraph(makeGraph(), "pi", 3, 20);
    const visited = new Set<string>(["pi"]);
    for (const hop of hops) {
      for (const edge of hop) {
        expect(visited.has(edge.to)).toBe(false);
        visited.add(edge.to);
      }
    }
  });
});

describe("renderEntityGraph", () => {
  it("renders typed edges around a seed with hop headers", () => {
    const graph = makeGraph();
    const seed = resolveSeedInGraph(graph, "pi")!;
    const text = renderEntityGraph(graph, {
      seedNode: seed.node,
      depth: 2,
      breadth: 20,
      maxTokens: 800,
    });
    expect(text).toContain("Entity graph around 'pi'");
    expect(text).toContain("Hop 1:");
    expect(text).toContain("pi -[cooccurrence]-> assistant (w=3184)");
    expect(text).toContain("pi -[cooccurrence]-> user (w=2816)");
    expect(text).toContain("Hop 2:");
    expect(text).toContain("user -[cooccurrence]-> vim (w=500)");
  });

  it("renders an overview of top entities and their edges without a seed", () => {
    const text = renderEntityGraph(makeGraph(), {
      depth: 2,
      breadth: 3,
      maxTokens: 800,
    });
    expect(text).toContain("Entity graph overview");
    expect(text).toContain("pi (7566 mentions)");
    expect(text).toContain("assistant (3184 mentions)");
    expect(text).toContain("user (2816 mentions)");
    expect(text).not.toContain("vim (900 mentions)"); // outside breadth 3
    expect(text).toContain("pi -[cooccurrence]-> assistant (w=3184)");
  });

  it("truncates at the token budget with a note", () => {
    const text = renderEntityGraph(makeGraph(), {
      seedNode: resolveSeedInGraph(makeGraph(), "pi")!.node,
      depth: 2,
      breadth: 20,
      maxTokens: 20,
    });
    expect(text).toContain("(truncated:");
    expect(text).toContain("of 3 edges)");
    // The note reports the traversal's own edge count, not the server's
    // post-limit window total.
    expect(text).not.toContain("of 5 edges)");
  });

  it("renders the empty-graph message for an empty bank", () => {
    const text = renderEntityGraph(
      { nodes: [], edges: [], total_entities: 0, total_edges: 0, limit: 0 },
      { depth: 2, breadth: 20, maxTokens: 800 }
    );
    expect(text).toContain("Entity graph is empty");
  });

  it("notes an ambiguous seed label", () => {
    const graph = makeGraph();
    graph.nodes.push({ data: { id: "pi2", label: "pi", mentionCount: 10 } });
    const seed = resolveSeedInGraph(graph, "PI")!;
    const text = renderEntityGraph(graph, {
      seedNode: seed.node,
      ambiguousSeed: seed.ambiguous,
      depth: 2,
      breadth: 20,
      maxTokens: 800,
    });
    expect(text).toContain("matched multiple entities");
  });

  it("renders a no-edges note for a seed with no edges in the window", () => {
    const graph = makeGraph();
    graph.nodes.push({ data: { id: "lonely", label: "lonely", mentionCount: 5 } });
    const text = renderEntityGraph(graph, {
      seedNode: { id: "lonely", label: "lonely", mentionCount: 5 },
      depth: 2,
      breadth: 20,
      maxTokens: 800,
    });
    expect(text).toContain("(no edges in the fetched graph window)");
  });

  it("budgets overview entity lines and notes truncated entities", () => {
    // A small budget must bound the entity list, not just the edges.
    const text = renderEntityGraph(makeGraph(), {
      depth: 2,
      breadth: 5,
      maxTokens: 30,
    });
    expect(text).toContain("(truncated:");
    expect(text).toContain("entities)");
    // The header is always present.
    expect(text).toContain("Entity graph overview");
  });

  it("budgets long entity labels in overview mode", () => {
    const graph = makeGraph();
    graph.nodes.push({
      data: {
        id: "long",
        label: "a very long entity label that keeps going and going and going",
        mentionCount: 9999,
      },
    });
    const text = renderEntityGraph(graph, {
      depth: 2,
      breadth: 5,
      maxTokens: 40,
    });
    // The long label is the top entity; the budget must still bound output.
    expect(text).toContain("(truncated:");
  });

  it("skips self-loop edges in traversal", () => {
    const graph = makeGraph();
    graph.edges.push({
      data: { id: "loop", source: "pi", target: "pi", linkType: "semantic", weight: 9999 },
    });
    const hops = traverseEntityGraph(graph, "pi", 2, 20);
    for (const hop of hops) {
      for (const edge of hop) {
        expect(edge.to).not.toBe(edge.from);
      }
    }
  });
});
