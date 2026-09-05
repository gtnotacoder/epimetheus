/**
 * Entity-graph traversal and rendering for the hindsight_graph tool.
 *
 * Pure functions over the server's entity co-occurrence graph response
 * (GET /v1/default/banks/{bank_id}/entities/graph). The server returns the
 * top-N co-occurrence edges by weight (N = the requested limit), so traversal
 * is bounded to that fetched window — entities whose strongest edges fall
 * outside the window are simply absent, and callers surface that honestly.
 */

/** A node in the entity co-occurrence graph (server wraps it in `data`). */
export interface EntityGraphNode {
  id: string;
  label: string;
  mentionCount: number;
}

/** A typed edge in the entity co-occurrence graph (server wraps it in `data`). */
export interface EntityGraphEdge {
  id: string;
  source: string;
  target: string;
  /** Edge type label, e.g. "cooccurrence" or "semantic". */
  linkType: string;
  weight: number;
  lastCooccurred?: string;
}

/** Raw server response for GET /entities/graph. */
export interface EntityGraphResponse {
  nodes: Array<{ data: EntityGraphNode }>;
  edges: Array<{ data: EntityGraphEdge }>;
  /** Post-limit window counts, NOT bank-wide totals. */
  total_entities: number;
  total_edges: number;
  limit: number;
}

/** One item from GET /entities (used for seed name resolution). */
export interface EntityListItem {
  id: string;
  canonical_name: string;
  mention_count: number;
}

/** Raw server response for GET /entities. */
export interface EntityListResponse {
  items: EntityListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** A rendered traversal edge: from -[linkType]-> to with weight. */
export interface GraphHopEdge {
  from: string;
  to: string;
  linkType: string;
  weight: number;
}

/** Result of resolving a seed string against the fetched graph nodes. */
export interface SeedResolution {
  node: EntityGraphNode;
  /** True when the seed label matched more than one node (highest mentionCount wins). */
  ambiguous: boolean;
}

/**
 * Resolve a seed string (entity id or label) against the fetched graph nodes.
 * Id match wins; otherwise case-insensitive label match, picking the highest
 * mentionCount when several nodes share the label. Returns null when the seed
 * is not present in the fetched window.
 */
export function resolveSeedInGraph(
  graph: EntityGraphResponse,
  seed: string
): SeedResolution | null {
  const nodes = graph.nodes.map((n) => n.data);
  const byId = nodes.find((n) => n.id === seed);
  if (byId) return { node: byId, ambiguous: false };

  const lower = seed.toLowerCase();
  const labelMatches = nodes.filter((n) => n.label.toLowerCase() === lower);
  if (labelMatches.length === 0) return null;

  const best = labelMatches.reduce((a, b) => (b.mentionCount > a.mentionCount ? b : a));
  return { node: best, ambiguous: labelMatches.length > 1 };
}

/**
 * Breadth-first traversal of the fetched graph from a seed node.
 *
 * Each hop visits at most `breadth` new nodes, taking the highest-weight
 * candidate edges first. Edges are undirected (the server's co-occurrence
 * edges have no direction), so each edge is rendered once, from the node
 * that discovered it. Self-loops and edges to already-visited nodes are
 * skipped. Returns one edge list per hop (empty when the seed is not in the
 * fetched window or has no edges).
 */
export function traverseEntityGraph(
  graph: EntityGraphResponse,
  seedId: string,
  depth: number,
  breadth: number
): GraphHopEdge[][] {
  const nodeIds = new Set(graph.nodes.map((n) => n.data.id));
  if (!nodeIds.has(seedId)) return [];

  // Undirected adjacency: both endpoints list the edge.
  const adjacency = new Map<string, Array<{ to: string; linkType: string; weight: number }>>();
  for (const e of graph.edges) {
    const d = e.data;
    if (!nodeIds.has(d.source) || !nodeIds.has(d.target)) continue;
    const fromList = adjacency.get(d.source) ?? [];
    fromList.push({ to: d.target, linkType: d.linkType, weight: d.weight });
    adjacency.set(d.source, fromList);
    const toList = adjacency.get(d.target) ?? [];
    toList.push({ to: d.source, linkType: d.linkType, weight: d.weight });
    adjacency.set(d.target, toList);
  }

  const hops: GraphHopEdge[][] = [];
  const visited = new Set<string>([seedId]);
  let frontier = [seedId];

  for (let hop = 0; hop < depth; hop++) {
    // Collect candidate edges from the frontier, highest weight first.
    const candidates: GraphHopEdge[] = [];
    for (const nodeId of frontier) {
      for (const n of adjacency.get(nodeId) ?? []) {
        if (visited.has(n.to)) continue;
        candidates.push({ from: nodeId, to: n.to, linkType: n.linkType, weight: n.weight });
      }
    }
    candidates.sort((a, b) => b.weight - a.weight);

    const hopEdges: GraphHopEdge[] = [];
    const nextFrontier: string[] = [];
    for (const c of candidates) {
      if (nextFrontier.length >= breadth) break;
      if (visited.has(c.to)) continue;
      visited.add(c.to);
      nextFrontier.push(c.to);
      hopEdges.push(c);
    }
    if (hopEdges.length === 0) break;
    hops.push(hopEdges);
    frontier = nextFrontier;
  }

  return hops;
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Render one typed edge line: `pi -[cooccurrence]-> assistant (w=3184)`. */
function renderEdgeLine(edge: GraphHopEdge, nodeLabels: Map<string, string>): string {
  const from = nodeLabels.get(edge.from) ?? edge.from;
  const to = nodeLabels.get(edge.to) ?? edge.to;
  return `${from} -[${edge.linkType}]-> ${to} (w=${edge.weight})`;
}

export interface RenderEntityGraphOptions {
  /** Resolved seed node (from resolveSeedInGraph); undefined = overview mode. */
  seedNode?: EntityGraphNode;
  /** True when the seed label matched multiple nodes (adds a note line). */
  ambiguousSeed?: boolean;
  depth: number;
  breadth: number;
  maxTokens: number;
}

/**
 * Render the fetched entity graph as compact typed-edge text.
 *
 * Overview mode (no seedNode): the top `breadth` entities by mention count
 * plus the highest-weight edges among them. Seed mode: BFS hops from the seed
 * with per-hop breadth caps. Output is token-budgeted: header lines are always
 * included, edge lines are added until the budget is exhausted, and dropped
 * edges produce a `(truncated: N of M edges)` note. Never emits raw JSON.
 */
export function renderEntityGraph(
  graph: EntityGraphResponse,
  opts: RenderEntityGraphOptions
): string {
  const nodes = graph.nodes.map((n) => n.data);
  const nodeLabels = new Map(nodes.map((n) => [n.id, n.label]));

  if (nodes.length === 0) {
    return "Entity graph is empty (no entities in this bank — check the bank id/config).";
  }

  const lines: string[] = [];
  let budget = opts.maxTokens;

  /** Emit a line when it fits the remaining budget. */
  const emit = (line: string): boolean => {
    const cost = estimateTokens(line);
    if (budget - cost < 0) return false;
    lines.push(line);
    budget -= cost;
    return true;
  };

  if (opts.seedNode) {
    const seed = opts.seedNode;
    // The header is essential context — always shown, even if it alone
    // exceeds the budget (the schema floor of 100 tokens makes this moot).
    const header = `Entity graph around '${seed.label}' (id ${seed.id}, ${seed.mentionCount} mentions):`;
    lines.push(header);
    budget -= estimateTokens(header);
    if (opts.ambiguousSeed) {
      emit(`(label '${seed.label}' matched multiple entities; showing the most-mentioned)`);
    }

    const hops = traverseEntityGraph(graph, seed.id, opts.depth, opts.breadth);
    const totalEdges = hops.reduce((sum, h) => sum + h.length, 0);
    let rendered = 0;
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      if (!hop || hop.length === 0) continue;
      if (!emit(`Hop ${i + 1}:`)) {
        break;
      }
      for (const edge of hop) {
        if (!emit(`  ${renderEdgeLine(edge, nodeLabels)}`)) {
          break;
        }
        rendered += 1;
      }
    }
    if (totalEdges === 0) {
      emit("(no edges in the fetched graph window)");
    }
    if (rendered < totalEdges) {
      lines.push(`(truncated: ${rendered} of ${totalEdges} edges)`);
    }
    return lines.join("\n");
  }

  // Overview mode: top entities by mention count plus their top edges.
  const header = `Entity graph overview (top ${opts.breadth} entities of the fetched top-${graph.edges.length} edge window):`;
  lines.push(header);
  budget -= estimateTokens(header);
  const topNodes = [...nodes]
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, opts.breadth);
  const topIds = new Set(topNodes.map((n) => n.id));
  let renderedEntities = 0;
  for (const n of topNodes) {
    if (!emit(`  ${n.label} (${n.mentionCount} mentions)`)) {
      break;
    }
    renderedEntities += 1;
  }
  if (renderedEntities < topNodes.length) {
    lines.push(`(truncated: ${renderedEntities} of ${topNodes.length} entities)`);
  }

  const topEdges = graph.edges
    .map((e) => e.data)
    .filter((e) => topIds.has(e.source) && topIds.has(e.target))
    .sort((a, b) => b.weight - a.weight);
  if (topEdges.length > 0) {
    emit("Edges:");
  }
  let rendered = 0;
  for (const e of topEdges) {
    if (
      !emit(
        `  ${renderEdgeLine({ from: e.source, to: e.target, linkType: e.linkType, weight: e.weight }, nodeLabels)}`
      )
    ) {
      break;
    }
    rendered += 1;
  }
  if (rendered < topEdges.length) {
    lines.push(`(truncated: ${rendered} of ${topEdges.length} edges)`);
  }
  return lines.join("\n");
}
