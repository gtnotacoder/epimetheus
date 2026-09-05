/**
 * Manual tools for Hindsight memory operations.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Budget, RecallResponse, ReflectResponse } from "@vectorize-io/hindsight-client";
import { type Static, Type } from "typebox";
import type { HindsightClientWrapper } from "./client";
import type { HindsightConfig, MemoryType, ToolName } from "./config";
import { CONSOLIDATION_TASK_TYPE, type OperationItem, renderOperations } from "./consolidation";
import { renderMemories } from "./curate";
import { renderEntityGraph, resolveSeedInGraph } from "./graph";
import { getHindsightMeta, shouldSessionBeRetained, updateSessionMetadata } from "./meta";
import { resolveProjectName } from "./project-config";
import { queueToolRetain } from "./retention";
import {
  getRegisteredHindsightTools,
  isOperationalReady,
  setRegisteredHindsightTools,
} from "./runtime-state";
import { extractParentSessionId } from "./utils";

// Reusable schemas
/** Tags match strategy for recall/reflect operations. */
const TagsMatchSchema = Type.Union(
  [
    Type.Literal("any"),
    Type.Literal("all"),
    Type.Literal("any_strict"),
    Type.Literal("all_strict"),
    Type.Literal("exact"),
  ],
  {
    description:
      "Match mode: 'any'(OR)/'all'(AND), '_strict' variants exclude untagged, 'exact' requires tag set equality (no tags/null/empty tag list matches untagged memories). Default: 'any'.",
  }
);
type TagsMatch = Static<typeof TagsMatchSchema>;

const MemoryTypeSchema = Type.Union([
  Type.Literal("world"),
  Type.Literal("experience"),
  Type.Literal("observation"),
]);

/** Budget level for recall/reflect operations. */
const BudgetSchema = Type.Union([Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")], {
  description:
    "Budget level: 'low', 'mid', or 'high'. Controls how much effort to spend on retrieval and reasoning.",
});

interface RetainDetails {
  success: boolean;
  error?: string;
}

interface RecallDetails {
  success: boolean;
  error?: string;
  response?: RecallResponse;
}

interface ReflectDetails {
  success: boolean;
  error?: string;
  response?: ReflectResponse;
}

interface ExtraContextDetails {
  success: boolean;
  extraContext?: string;
  error?: string;
}

interface GraphDetails {
  success: boolean;
  error?: string;
}

interface ConsolidateDetails {
  success: boolean;
  error?: string;
}

interface CurateDetails {
  success: boolean;
  error?: string;
}

/**
 * Check if a specific tool is enabled based on config.toolsEnabled.
 * - `true` (default): all tools enabled
 * - `false`: no tools enabled
 * - array of tool names: only listed tools enabled
 */
export function isToolEnabled(config: HindsightConfig, tool: ToolName): boolean {
  const { toolsEnabled } = config;
  if (typeof toolsEnabled === "boolean") return toolsEnabled;
  return toolsEnabled.includes(tool);
}

/**
 * Normalize a curation reason: trim whitespace, reject empty-after-trim
 * (returns null), and cap at 500 chars so the recorded reason stays bounded.
 */
function normalizeReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

/**
 * Queue a supersede successor through the existing retain path, mirroring
 * hindsight_retain's execute (session retention check, project-aware cwd,
 * fail-closed project-name resolution). Returns a failure message, or null
 * when the successor was queued.
 */
async function queueSuccessorRetain(
  ctx: ExtensionContext,
  config: HindsightConfig,
  content: string
): Promise<string | null> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) {
    return "no active session";
  }

  const entries = ctx.sessionManager.getEntries();
  if (!shouldSessionBeRetained(entries, config)) {
    return "Session does not allow retention. Use /hindsight toggle-retain to enable retention.";
  }

  const header = ctx.sessionManager.getHeader();
  const parentSessionId = extractParentSessionId(header?.parentSession);

  const meta = getHindsightMeta(entries);
  const sessionUserTags = meta?.tags ?? [];

  const retainCwd = header?.cwd ?? ctx.cwd;
  const projectNameResult = resolveProjectName(retainCwd, meta?.usesProjectConfig);
  if (!projectNameResult.ok) {
    const recoveryAdvice =
      projectNameResult.recovery === "fix-config"
        ? `Fix the config at ${retainCwd}/.pi/epimetheus/config.jsonc.`
        : `Use /hindsight detach-project-name to stop requiring the project-local projectName override, or restore the config at ${retainCwd}/.pi/epimetheus/.`;
    return `${projectNameResult.error}. ${recoveryAdvice}`;
  }

  const result = await queueToolRetain(
    sessionId,
    content,
    undefined,
    undefined,
    retainCwd,
    parentSessionId,
    config,
    sessionUserTags,
    projectNameResult.projectName
  );
  if (!result.success) {
    return result.error ?? "unknown error";
  }
  return null;
}

/**
 * Register the hindsight manual tools:
 * `hindsight_set_extra_context`, `hindsight_get_extra_context`, `hindsight_retain`,
 * `hindsight_recall`, `hindsight_reflect`, `hindsight_graph`,
 * `hindsight_consolidate`, and `hindsight_curate`. Each is gated by
 * `config.toolsEnabled` (via {@link isToolEnabled}) — `true` (default) enables
 * all, `false` disables all, and an array enables only the listed tool names.
 * The extra-context and retain tools are client-free (disk/local operations),
 * so they are registered based solely on `toolsEnabled`. `hindsight_recall`,
 * `hindsight_reflect`, `hindsight_graph`, `hindsight_consolidate`, and
 * `hindsight_curate` need a live client and are not registered at all
 * when `client` is null (`if (!client) return;` runs before their blocks).
 *
 * This is called lazily from the `session_start` success path (after health +
 * version checks pass), not at extension init. Late `registerTool()`
 * auto-activates the tools via `refreshTools`, so they are visible to the LLM
 * from the first agent turn on; callers then re-apply retention-based
 * visibility via {@link updateRetainToolVisibility}.
 */
export function registerTools(
  pi: ExtensionAPI,
  config: HindsightConfig,
  client: HindsightClientWrapper | null
): string[] {
  const registered: string[] = [];
  if (isToolEnabled(config, "set_extra_context")) {
    registered.push("hindsight_set_extra_context");
    pi.registerTool({
      name: "hindsight_set_extra_context",
      label: "Hindsight Extra Context",
      description:
        "Set extra context/caveats for memory extraction. Use when the session involves content that could be misclassified when split into chunks.",
      parameters: Type.Object({
        text: Type.String({
          description:
            "The extra context. Replaces any existing value. Example: 'This session involves reading Dune; characters are not the user and information is not factual.'",
        }),
      }),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as ExtraContextDetails;
        if (details.success) {
          if (details.extraContext) {
            text.setText(theme.fg("success", `✓ Extra context set: ${details.extraContext}`));
          } else {
            text.setText(theme.fg("success", "✓ No extra context needed (flush guard satisfied)"));
          }
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to set extra context"}`));
        }
        return text;
      },

      async execute(
        _toolCallId,
        params,
        _signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<ExtraContextDetails>> {
        const entries = ctx.sessionManager.getEntries();

        const extraContext = params.text.trim();
        // Always store extraContext (even empty string) so the flush guard
        // can distinguish "explicitly set to empty" from "never set".
        const sessionId = ctx.sessionManager.getSessionId();
        await updateSessionMetadata(pi, sessionId, entries, { extraContext }, config);

        const message = extraContext
          ? "Extra context set."
          : "No extra context needed (flush guard satisfied).";

        return {
          content: [{ type: "text", text: message }],
          details: { success: true, extraContext },
        };
      },
    });
  }

  if (isToolEnabled(config, "get_extra_context")) {
    registered.push("hindsight_get_extra_context");
    pi.registerTool({
      name: "hindsight_get_extra_context",
      label: "Hindsight Get Extra Context",
      description: "Get the current extra context set for this session.",
      parameters: Type.Object({}),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as ExtraContextDetails;
        if (details.success) {
          if (details.extraContext) {
            text.setText(theme.fg("success", `✓ Extra context: ${details.extraContext}`));
          } else if (details.extraContext === "") {
            text.setText(theme.fg("success", "✓ No extra context needed (flush guard satisfied)"));
          } else {
            text.setText(theme.fg("success", "✓ No extra context set"));
          }
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to get extra context"}`));
        }
        return text;
      },

      async execute(
        _toolCallId,
        _params,
        _signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<ExtraContextDetails>> {
        const entries = ctx.sessionManager.getEntries();
        const existingMeta = getHindsightMeta(entries);
        const extraContext = existingMeta?.extraContext;

        const message =
          extraContext !== undefined
            ? extraContext || "No extra context needed (flush guard satisfied)"
            : "No extra context set";

        return {
          content: [{ type: "text", text: message }],
          details: { success: true, extraContext },
        };
      },
    });
  }

  // Register hindsight_retain if enabled
  if (isToolEnabled(config, "retain")) {
    registered.push("hindsight_retain");
    // hindsight_retain - always available, just queues to disk
    pi.registerTool({
      name: "hindsight_retain",
      label: "Hindsight Retain",
      description:
        "Store information to long-term memory. Use for facts, preferences, decisions, or anything worth remembering across sessions",
      parameters: Type.Object({
        content: Type.String({ description: "Information to store" }),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Tags for recall filtering, e.g. 'topic:billing'",
          })
        ),
        metadata: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Extra context for fact extraction. Returned with recalled memories but can't use for recall filtering.",
          })
        ),
      }),

      renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
        const details = result.details as RetainDetails;
        if (details.success) {
          const retained = context.args.content ?? "";
          text.setText(
            `${theme.fg("success", "✓ Memory queued for storage")}\n${theme.fg("dim", retained)}`
          );
        } else {
          text.setText(theme.fg("error", `✗ ${details.error ?? "Failed to store memory"}`));
        }
        return text;
      },

      async execute(
        _toolCallId,
        params,
        _signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<RetainDetails>> {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId) {
          return {
            content: [{ type: "text", text: "Failed to store memory: no active session" }],
            details: { success: false, error: "no active session" },
          };
        }

        // Check if session is retained
        const entries = ctx.sessionManager.getEntries();
        if (!shouldSessionBeRetained(entries, config)) {
          return {
            content: [
              {
                type: "text",
                text: "Warning: Session does not allow retention. Use /hindsight toggle-retain to enable retention.",
              },
            ],
            details: { success: false, error: "session does not allow retention" },
          };
        }

        const header = ctx.sessionManager.getHeader();
        const parentSessionId = extractParentSessionId(header?.parentSession);

        // Get session tags from metadata
        const meta = getHindsightMeta(entries);
        const sessionUserTags = meta?.tags ?? [];

        // Resolve the project name project-aware so tool retains share the
        // same `project:` tag as session flushes. The session's recorded cwd
        // (header.cwd) is authoritative — matches what the upsert path uses.
        // If the session is marked as using project-local config and the
        // resolution fails (cwd gone, or config missing/invalid), fail closed:
        // do not queue — the memory would otherwise be tagged with the wrong
        // project name
        const retainCwd = header?.cwd ?? ctx.cwd;
        const projectNameResult = resolveProjectName(retainCwd, meta?.usesProjectConfig);
        if (!projectNameResult.ok) {
          const recoveryAdvice =
            projectNameResult.recovery === "fix-config"
              ? `Fix the config at ${retainCwd}/.pi/epimetheus/config.jsonc.`
              : `Use /hindsight detach-project-name to stop requiring the project-local projectName override, or restore the config at ${retainCwd}/.pi/epimetheus/.`;
          return {
            content: [
              {
                type: "text",
                text: `Failed to store memory: ${projectNameResult.error}. ${recoveryAdvice}`,
              },
            ],
            details: { success: false, error: projectNameResult.error },
          };
        }

        const result = await queueToolRetain(
          sessionId,
          params.content,
          params.tags,
          params.metadata,
          retainCwd,
          parentSessionId,
          config,
          sessionUserTags,
          projectNameResult.projectName
        );
        if (!result.success) {
          return {
            content: [{ type: "text", text: `Failed to queue memory: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }

        return {
          content: [{ type: "text", text: "Memory queued for storage." }],
          details: { success: true },
        };
      },
    });
  }

  // recall and reflect require client. Record client-free tools before
  // returning so visibility restoration and diagnostics reflect what Pi has.
  if (!client) {
    setRegisteredHindsightTools(registered);
    return registered;
  }

  // Register hindsight_recall if enabled
  if (isToolEnabled(config, "recall")) {
    registered.push("hindsight_recall");
    pi.registerTool({
      name: "hindsight_recall",
      label: "Hindsight Recall",
      description: "Search long-term memory",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Filter by tags",
          })
        ),
        tagsMatch: Type.Optional(TagsMatchSchema),
        // TODO: Consider adding tag_groups for complex tag matching (may be unnecessary and overly complex)
        types: Type.Optional(
          Type.Array(MemoryTypeSchema, {
            description:
              "Filter by type: `world` (external facts), `experience` (user-specific), `observation` (consolidated patterns). Default: all types.",
          })
        ),
        budget: Type.Optional(BudgetSchema),
      }),

      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        _ctx
      ): Promise<AgentToolResult<RecallDetails>> {
        // Use config default if not specified, otherwise use params
        const types = params.types ?? config.autoRecallTypes ?? undefined;
        const result = await client.recall(
          {
            query: params.query,
            tags: params.tags,
            tagsMatch: params.tagsMatch as TagsMatch | undefined,
            types: types as MemoryType[] | undefined,
            budget: params.budget as Budget | undefined,
          },
          signal
        );

        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to recall memories: ${result.error ?? "unknown error"}`,
              },
            ],
            details: { success: false, error: result.error },
          };
        }

        const response = result.response;
        const results = response?.results ?? [];

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { success: true, response },
          };
        }

        const text = results.map((r, i) => `${i + 1}. ${r.text}`).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { success: true, response },
        };
      },
    });
  }

  // Register hindsight_reflect if enabled
  if (isToolEnabled(config, "reflect")) {
    registered.push("hindsight_reflect");
    pi.registerTool({
      name: "hindsight_reflect",
      label: "Hindsight Reflect",
      description:
        "Synthesize an answer from memories using multi-step reasoning. Use recall for raw facts or observations and reflect for answers, topic summaries, etc. requiring synthesis across many memories. Budget defaults to 'low'; higher budgets are much slower and should only be used if necessary",
      parameters: Type.Object({
        query: Type.String({ description: "Question to answer" }),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Filter by tags",
          })
        ),
        tagsMatch: Type.Optional(TagsMatchSchema),
        budget: Type.Optional(BudgetSchema),
      }),

      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        _ctx
      ): Promise<AgentToolResult<ReflectDetails>> {
        const result = await client.reflect(
          {
            query: params.query,
            tags: params.tags,
            tagsMatch: params.tagsMatch as TagsMatch | undefined,
            budget: params.budget as Budget | undefined,
          },
          signal
        );

        if (!result.success) {
          return {
            content: [
              { type: "text", text: `Failed to reflect: ${result.error ?? "unknown error"}` },
            ],
            details: { success: false, error: result.error },
          };
        }

        const response = result.response;
        const text = response?.text;

        if (!text) {
          return {
            content: [{ type: "text", text: "No relevant memories found to reflect on." }],
            details: { success: true, response },
          };
        }

        return {
          content: [{ type: "text", text }],
          details: { success: true, response },
        };
      },
    });
  }

  // Register hindsight_graph if enabled
  if (isToolEnabled(config, "graph")) {
    registered.push("hindsight_graph");
    pi.registerTool({
      name: "hindsight_graph",
      label: "Hindsight Entity Graph",
      description:
        "Explore the entity co-occurrence graph. Lists top entities and their typed edges (A -[type]-> B). Use seed to expand around an entity (depth/breadth caps), minCount to filter low-signal edges.",
      parameters: Type.Object({
        seed: Type.Optional(
          Type.String({
            description:
              "Entity id or name to expand around. Omit to list the top entities and their edges.",
          })
        ),
        depth: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 4,
            description: "Hops from the seed entity. Default: 2.",
          })
        ),
        breadth: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            description: "Max new nodes per hop. Default: 20.",
          })
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: 4000,
            description: "Token budget for the rendered edge list. Default: 800.",
          })
        ),
        minCount: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Minimum co-occurrence count for edges. Default: 0 (no filter).",
          })
        ),
      }),

      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        _ctx
      ): Promise<AgentToolResult<GraphDetails>> {
        const depth = params.depth ?? 2;
        const breadth = params.breadth ?? 20;
        const maxTokens = params.maxTokens ?? 800;
        const minCount = params.minCount ?? 0;
        // Fetch enough top edges to cover the BFS worst case (sum of b^k for
        // k=1..depth), capped at 1000 to bound the request.
        let fetchLimit = 0;
        for (let k = 1; k <= depth; k++) {
          fetchLimit += breadth ** k;
        }
        fetchLimit = Math.min(1000, fetchLimit);

        const graphResult = await client.getEntityGraph({ limit: fetchLimit, minCount }, signal);
        if (!graphResult.success) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch entity graph: ${graphResult.error ?? "unknown error"}`,
              },
            ],
            details: { success: false, error: graphResult.error },
          };
        }
        const graph = graphResult.response;
        if (!graph || graph.nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Entity graph is empty (no entities in this bank — check the bank id/config).",
              },
            ],
            details: { success: true },
          };
        }

        let seedNode: ReturnType<typeof resolveSeedInGraph> = null;
        if (params.seed) {
          seedNode = resolveSeedInGraph(graph, params.seed);
          if (!seedNode) {
            // The seed is not in the fetched top-N window. Distinguish
            // "entity exists but has no strong edges" from "unknown entity"
            // with a bounded scan of the top entities by mention count.
            const listResult = await client.getEntities({ limit: 500 }, signal);
            if (!listResult.success) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to resolve entity '${params.seed}': ${listResult.error ?? "unknown error"}`,
                  },
                ],
                details: { success: false, error: listResult.error },
              };
            }
            const lower = params.seed.toLowerCase();
            const matches = (listResult.response?.items ?? [])
              .filter((i) => i.id === params.seed || i.canonical_name.toLowerCase() === lower)
              .sort((a, b) => b.mention_count - a.mention_count);
            const best = matches[0];
            if (best) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Entity '${params.seed}' (id ${best.id}, ${best.mention_count} mentions) has no edges in the top ${fetchLimit} co-occurrence edges. Try higher breadth/depth or lower minCount.`,
                  },
                ],
                details: { success: true },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Entity '${params.seed}' not found (not in the top ${fetchLimit} co-occurrence edges and not in the top 500 entities by mention count). Call without a seed to list top entities.`,
                },
              ],
              details: { success: true },
            };
          }
        }

        const text = renderEntityGraph(graph, {
          seedNode: seedNode?.node,
          ambiguousSeed: seedNode?.ambiguous,
          depth,
          breadth,
          maxTokens,
        });

        return {
          content: [{ type: "text", text }],
          details: { success: true },
        };
      },
    });
  }

  // Register hindsight_consolidate if enabled
  if (isToolEnabled(config, "consolidate")) {
    registered.push("hindsight_consolidate");
    pi.registerTool({
      name: "hindsight_consolidate",
      label: "Hindsight Consolidate",
      description:
        "Consolidation watchdog: check or act on the server's consolidation state. status lists pending/failed consolidation operations; trigger starts consolidation (async and deduplicated server-side — reports the operation_id, does not poll to completion; re-run status later); recover retries failed consolidations. auto recovers failed ops first, then triggers when pending exceeds threshold.",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union([Type.Literal("status"), Type.Literal("trigger"), Type.Literal("recover")], {
            description: "Action: status (default), trigger, or recover.",
          })
        ),
        auto: Type.Optional(
          Type.Boolean({
            description:
              "When true, run the watchdog flow (overrides mode): recover failed consolidations first, then trigger when pending exceeds threshold. Default: false.",
          })
        ),
        threshold: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            description:
              "Pending consolidation count that triggers a new consolidation in auto mode. Default: 5.",
          })
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: 4000,
            description: "Token budget for the rendered operation list. Default: 600.",
          })
        ),
        observationScopes: Type.Optional(
          Type.Array(Type.Array(Type.String()), {
            description:
              "Tag scopes to consolidate (trigger mode). Each scope is a list of tags; only unconsolidated memories matching at least one scope are processed. Omit to consolidate all.",
          })
        ),
      }),

      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        _ctx
      ): Promise<AgentToolResult<ConsolidateDetails>> {
        const mode = params.auto ? "auto" : (params.mode ?? "status");
        const threshold = params.threshold ?? 5;
        const maxTokens = params.maxTokens ?? 600;

        // Fetch pending + failed operations in parallel (bounded at 50 each).
        const fetchSnapshot = async (): Promise<
          | {
              ok: true;
              pending: OperationItem[];
              failed: OperationItem[];
              pendingTotal: number;
              failedTotal: number;
              pendingCapped: boolean;
              failedCapped: boolean;
            }
          | { ok: false; error: string }
        > => {
          const [pendingResult, failedResult] = await Promise.all([
            client.getOperations({ status: "pending", limit: 50 }, signal),
            client.getOperations({ status: "failed", limit: 50 }, signal),
          ]);
          if (!pendingResult.success) {
            return {
              ok: false,
              error: `Failed to list pending operations: ${pendingResult.error ?? "unknown error"}`,
            };
          }
          if (!failedResult.success) {
            return {
              ok: false,
              error: `Failed to list failed operations: ${failedResult.error ?? "unknown error"}`,
            };
          }
          const pending = pendingResult.response?.operations ?? [];
          const failed = failedResult.response?.operations ?? [];
          return {
            ok: true,
            pending,
            failed,
            pendingTotal: pendingResult.response?.total ?? pending.length,
            failedTotal: failedResult.response?.total ?? failed.length,
            pendingCapped: pending.length >= 50,
            failedCapped: failed.length >= 50,
          };
        };

        const consolidationOps = (ops: OperationItem[]): OperationItem[] =>
          ops.filter((o) => o.task_type === CONSOLIDATION_TASK_TYPE);

        if (mode === "status") {
          const snapshot = await fetchSnapshot();
          if (!snapshot.ok) {
            return {
              content: [{ type: "text", text: snapshot.error }],
              details: { success: false, error: snapshot.error },
            };
          }
          const ops = [...consolidationOps(snapshot.pending), ...consolidationOps(snapshot.failed)];
          return {
            content: [{ type: "text", text: renderOperations(ops, { maxTokens }) }],
            details: { success: true },
          };
        }

        if (mode === "trigger") {
          // Drop empty inner scopes; an empty result means "consolidate all".
          const scopes = (params.observationScopes ?? []).filter((s) => s.length > 0);
          const result = await client.consolidate(
            scopes.length > 0 ? { observationScopes: scopes } : {},
            signal
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to trigger consolidation: ${result.error ?? "unknown error"}`,
                },
              ],
              details: { success: false, error: result.error },
            };
          }
          const opId = result.response?.operation_id ?? "unknown";
          const dedupNote = result.response?.deduplicated
            ? " (deduplicated — existing pending task reused)"
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Consolidation triggered: operation ${opId}${dedupNote}`,
              },
            ],
            details: { success: true },
          };
        }

        if (mode === "recover") {
          const result = await client.recoverConsolidation(signal);
          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to recover consolidations: ${result.error ?? "unknown error"}`,
                },
              ],
              details: { success: false, error: result.error },
            };
          }
          const count = result.response?.retried_count ?? 0;
          return {
            content: [
              {
                type: "text",
                text: `Recovered ${count} failed consolidation operation(s).`,
              },
            ],
            details: { success: true },
          };
        }

        if (mode === "auto") {
          const snapshot = await fetchSnapshot();
          if (!snapshot.ok) {
            return {
              content: [{ type: "text", text: snapshot.error }],
              details: { success: false, error: snapshot.error },
            };
          }
          const failedOps = consolidationOps(snapshot.failed);
          const pendingOps = consolidationOps(snapshot.pending);
          const lines: string[] = [];

          // Recover first when failed consolidation ops exist.
          if (failedOps.length > 0) {
            const result = await client.recoverConsolidation(signal);
            if (!result.success) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to recover consolidations: ${result.error ?? "unknown error"}`,
                  },
                ],
                details: { success: false, error: result.error },
              };
            }
            lines.push(
              `Recovered ${result.response?.retried_count ?? 0} failed consolidation operation(s).`
            );
          } else {
            lines.push("No failed consolidation operations to recover.");
          }

          // Threshold check on the client-filtered consolidation count.
          // The server's `total` is status-filtered but NOT task_type-filtered,
          // so it cannot stand in for a consolidation count. When the fetched
          // page hit the cap, note the uncertainty instead of guessing.
          const pendingCount = pendingOps.length;
          if (snapshot.pendingCapped) {
            lines.push(
              `(pending list capped at 50; server total ${snapshot.pendingTotal} — consolidation count may be understated)`
            );
          }
          if (pendingCount > threshold) {
            const result = await client.consolidate({}, signal);
            if (!result.success) {
              lines.push(`Failed to trigger consolidation: ${result.error ?? "unknown error"}`);
              return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { success: false, error: result.error },
              };
            }
            const opId = result.response?.operation_id ?? "unknown";
            const dedupNote = result.response?.deduplicated
              ? " (deduplicated — existing pending task reused)"
              : "";
            lines.push(`Consolidation triggered: operation ${opId}${dedupNote}`);
          } else {
            lines.push(
              `Pending consolidation count ${pendingCount} ≤ threshold ${threshold} — nothing to trigger.`
            );
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { success: true },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Unknown mode '${String(mode)}'. Valid modes: status, trigger, recover.`,
            },
          ],
          details: { success: false, error: `unknown mode: ${String(mode)}` },
        };
      },
    });
  }

  // Register hindsight_curate if enabled
  if (isToolEnabled(config, "curate")) {
    registered.push("hindsight_curate");
    pi.registerTool({
      name: "hindsight_curate",
      label: "Hindsight Curate",
      description:
        "Curate the memory bank's fact lifecycle. find (default) searches memories (q text search, optional state filter) and lists candidates one per line; invalidate soft-retires a memory with a REQUIRED reason (deliberate-only — the reason is recorded server-side and visible in the memory's history); supersede invalidates a memory naming its successor and queues the successor for storage (two-step); revert restores an invalidated memory to valid. Invalidation is reversible via revert. Raise maxTokens (up to 4000) for larger listings — the 600 default fits roughly 17 lines.",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union(
            [
              Type.Literal("find"),
              Type.Literal("invalidate"),
              Type.Literal("supersede"),
              Type.Literal("revert"),
            ],
            {
              description:
                "Operation mode. find (default) lists candidate memories; invalidate soft-retires one with a reason; supersede invalidates one and queues its successor; revert restores an invalidated memory to valid.",
            }
          )
        ),
        q: Type.Optional(
          Type.String({
            description:
              "Text search query (find mode). Omit to list recent memories. An empty string is treated as omitted.",
          })
        ),
        state: Type.Optional(
          Type.Union([Type.Literal("valid"), Type.Literal("invalidated")], {
            description: "Filter candidates by state (find mode). Default: no filter.",
          })
        ),
        memoryId: Type.Optional(
          Type.String({
            description: "Memory id to act on. Required for invalidate, supersede, and revert.",
          })
        ),
        reason: Type.Optional(
          Type.String({
            description:
              "Why the memory is being retired. REQUIRED for invalidate (every retirement must be explained); optional for supersede (defaults to 'Superseded by: <successor snippet>'). Recorded server-side.",
          })
        ),
        successor: Type.Optional(
          Type.String({
            description:
              "The new fact text that replaces the invalidated memory. Required for supersede.",
          })
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: 4000,
            description: "Token budget for the rendered candidate list (find mode). Default: 600.",
          })
        ),
      }),

      async execute(
        _toolCallId,
        params,
        signal,
        _onUpdate,
        ctx
      ): Promise<AgentToolResult<CurateDetails>> {
        const mode = params.mode ?? "find";
        const maxTokens = params.maxTokens ?? 600;

        if (mode === "find") {
          const listResult = await client.listMemories(
            { q: params.q, state: params.state, limit: 20 },
            signal
          );
          if (!listResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to list memories: ${listResult.error ?? "unknown error"}`,
                },
              ],
              details: { success: false, error: listResult.error },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: renderMemories(listResult.response?.items ?? [], { maxTokens }),
              },
            ],
            details: { success: true },
          };
        }

        if (mode === "invalidate" || mode === "supersede" || mode === "revert") {
          if (!params.memoryId) {
            return {
              content: [{ type: "text", text: `memoryId is required for ${mode}` }],
              details: { success: false, error: "memoryId is required" },
            };
          }
          const idPrefix = params.memoryId.slice(0, 8);

          if (mode === "revert") {
            const result = await client.updateMemory(params.memoryId, { state: "valid" }, signal);
            if (!result.success) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to revert memory: ${result.error ?? "unknown error"}`,
                  },
                ],
                details: { success: false, error: result.error },
              };
            }
            return {
              content: [{ type: "text", text: `Reverted ${idPrefix} to valid.` }],
              details: { success: true },
            };
          }

          // invalidate and supersede share the PATCH step. The reason is
          // trimmed and capped; an empty-after-trim reason fails invalidate
          // (deliberate-only) and falls back to the successor default for
          // supersede.
          let reason: string;
          let successor = "";
          if (mode === "invalidate") {
            const normalized = normalizeReason(params.reason);
            if (!normalized) {
              return {
                content: [
                  {
                    type: "text",
                    text: "reason is required to invalidate — every retirement must be explained",
                  },
                ],
                details: { success: false, error: "reason is required" },
              };
            }
            reason = normalized;
          } else {
            if (!params.successor) {
              return {
                content: [{ type: "text", text: "successor is required for supersede" }],
                details: { success: false, error: "successor is required" },
              };
            }
            successor = params.successor.trim();
            if (successor === "") {
              return {
                content: [{ type: "text", text: "successor is required for supersede" }],
                details: { success: false, error: "successor is required" },
              };
            }
            reason = normalizeReason(params.reason) ?? `Superseded by: ${successor.slice(0, 80)}`;
          }

          const patchResult = await client.updateMemory(
            params.memoryId,
            { state: "invalidated", reason },
            signal
          );
          if (!patchResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to invalidate memory: ${patchResult.error ?? "unknown error"}`,
                },
              ],
              details: { success: false, error: patchResult.error },
            };
          }

          if (mode === "invalidate") {
            return {
              content: [{ type: "text", text: `Invalidated ${idPrefix}: ${reason}` }],
              details: { success: true },
            };
          }

          // supersede: retain the successor via the existing retain path,
          // mirroring hindsight_retain's execute (session retention check,
          // project-aware cwd, fail-closed project-name resolution). The
          // invalidation already happened, so the two-step report states both
          // outcomes honestly.
          const retainFailure = await queueSuccessorRetain(ctx, config, successor);
          if (retainFailure) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalidated ${idPrefix}: ${reason}\nSuccessor NOT queued: ${retainFailure}`,
                },
              ],
              details: { success: true },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Invalidated ${idPrefix}: ${reason}\nSuccessor queued for storage.`,
              },
            ],
            details: { success: true },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Unknown mode '${String(mode)}'. Valid modes: find, invalidate, supersede, revert.`,
            },
          ],
          details: { success: false, error: `unknown mode: ${String(mode)}` },
        };
      },
    });
  }

  setRegisteredHindsightTools(registered);
  return registered;
}

/**
 * The canonical tool-name namespace reserved by epimetheus. Visibility uses
 * exact names rather than the `hindsight_` prefix, so a foreign tool that only
 * shares the prefix (e.g. `hindsight_foreign`) is preserved. Extensions that
 * register one of these exact canonical names are incompatible with epimetheus.
 */
const HINDSIGHT_OWNED_TOOLS = new Set([
  "hindsight_set_extra_context",
  "hindsight_get_extra_context",
  "hindsight_retain",
  "hindsight_recall",
  "hindsight_reflect",
  "hindsight_graph",
  "hindsight_consolidate",
  "hindsight_curate",
]);

/**
 * Refresh the visibility of all registered Hindsight tools based on the
 * unified operational state and the session's retention flag.
 *
 * Ownership is by EXACT canonical epimetheus tool name (see
 * {@link HINDSIGHT_OWNED_TOOLS}), not by the `hindsight_` prefix. Every
 * currently-active tool outside that reserved namespace is preserved unchanged
 * — even one that merely shares the prefix (e.g. `hindsight_foreign`). An
 * extension that registers one of epimetheus's exact canonical names is
 * incompatible and may have that tool hidden by this visibility manager.
 *
 * - Degraded (`!isOperationalReady()`): hide all OWNED hindsight tools so the
 *   LLM never sees any of them (no recall/reflect/retain/extra-context). This
 *   is the single degraded mode regardless of cause (unreachable/incompatible
 *   server, or required-but-missing/invalid cwd-local project config). Non-owned
 *   tools are preserved.
 * - Operational: show all registered hindsight tools, except `hindsight_retain`
 *   is hidden when the session is not retained (so the LLM never sees a tool
 *   whose calls would fail). `retained` has no effect on the other tools.
 *
 * Reads `isOperationalReady()` and the registered-tool list from
 * `runtime-state`, so callers only need to pass the session's `retained` flag.
 *
 * Note: in operational mode, registered hindsight tools are always re-added
 * (subject to the retained gate), even if one was deactivated outside this
 * extension (e.g. a Pi tool allowlist/exclusion). This deliberately keeps the
 * current intended operational/retention semantics; no speculative per-tool
 * deactivation recovery is attempted here.
 *
 * Enabling/disabling tools is the only place degraded mode is enforced — there
 * are no operational-state checks inside tool execute handlers.
 */
export function refreshToolVisibility(pi: ExtensionAPI, retained: boolean): void {
  const activeNames = pi.getActiveTools();
  // Preserve currently-active tools outside epimetheus's reserved canonical
  // names. A foreign tool merely sharing the `hindsight_` prefix is kept.
  const nonOwned = activeNames.filter((n) => !HINDSIGHT_OWNED_TOOLS.has(n));

  if (!isOperationalReady()) {
    // Degraded: hide all owned hindsight tools; keep non-owned tools.
    pi.setActiveTools(nonOwned);
    return;
  }

  // Operational: show all registered hindsight tools except retain when not
  // retained.
  const toShow = getRegisteredHindsightTools().filter(
    (name) => name !== "hindsight_retain" || retained
  );
  pi.setActiveTools([...nonOwned, ...toShow]);
}
