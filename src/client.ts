/**
 * Hindsight client wrapper with timeout and error handling.
 */

import {
  type Budget,
  type EntityInput,
  HindsightClient,
  HindsightError,
  type MemoryItemInput,
  type RecallResponse,
  type ReflectResponse,
} from "@vectorize-io/hindsight-client";
import type { HindsightConfig, ObservationScopes, TagGroupInput, TagsMatch } from "./config";
import type {
  ConsolidationResponse,
  OperationsListResponse,
  RecoverConsolidationResponse,
} from "./consolidation";
import type { MemoryListResponse, MemoryUnit } from "./curate";
import type { EntityGraphResponse, EntityListResponse } from "./graph";

export interface RetainOptions {
  content: string;
  timestamp?: string;
  context?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  documentId?: string;
  updateMode?: "replace" | "append";
  entities?: EntityInput[];
  /** Observation scopes for controlling how observations are consolidated. */
  observationScopes?: ObservationScopes;
}

export interface RecallOptions {
  query: string;
  tags?: string[];
  tagsMatch?: TagsMatch;
  tagGroups?: TagGroupInput[];
  types?: ("world" | "experience" | "observation")[];
  budget?: Budget;
  maxTokens?: number | null;
}

export interface ReflectOptions {
  query: string;
  /** Filter memories by tags during reflection. If not specified, all memories are considered. */
  tags?: string[];
  /** How to match tags: 'any' (OR, includes untagged), 'all' (AND, includes untagged), 'any_strict' (OR, excludes untagged), 'all_strict' (AND, excludes untagged), 'exact' (tag set equality; no tags/null/empty tag list matches untagged memories). Default: 'any'. */
  tagsMatch?: TagsMatch;
  /** Budget level controlling how much effort to spend on retrieval and reasoning: 'low', 'mid', or 'high'.
   *  Default: 'low' (per Hindsight SDK). Reflect runs an agentic loop with up to 10 iterations
   *  of multi-tool search + LLM calls, so it is substantially slower than recall even at low budget. */
  budget?: Budget;
  // Not currently exposed (simplified HindsightClient wrapper doesn't support these;
  // the underlying ReflectRequest API supports fact_types, exclude_mental_models,
  // exclude_mental_model_ids, tag_groups, max_tokens, include, response_schema):
  // - fact_types / exclude_mental_models: can be added if the client SDK is updated
  //   or when switching to the generated SDK directly
  // - tag_groups: can be added for reflect similar to recall if needed but
  //   probably overly complex (seems unlikely LLM tool needs advanced tags)
  // - max_tokens: not currently configurable (default 4096 output)
  // - response_schema: not adding for now as structured output seems less useful
  //   for coding agent integration
  // - include: can be added later if needed (for trace, facts, chunks, etc.)
}

export class HindsightClientWrapper {
  private client: HindsightClient;
  private config: HindsightConfig;

  constructor(config: HindsightConfig) {
    this.config = config;
    this.client = new HindsightClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  /**
   * Check server health by pinging the health endpoint.
   */
  async healthCheck(
    signal?: AbortSignal,
    timeoutMs: number = 5000
  ): Promise<{ success: boolean; error?: string }> {
    const controller = new AbortController();
    let timedOut = false;

    // Chain external abort signal
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        abortHandler = () => controller.abort();
        signal.addEventListener("abort", abortHandler);
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const response = await fetch(`${this.config.apiUrl}/health`, {
        signal: controller.signal,
      });

      if (response.ok) {
        return { success: true };
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (timedOut) {
          return { success: false, error: `Operation timed out after ${timeoutMs}ms` };
        }
        return { success: false, error: "Operation cancelled" };
      }
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Query the Hindsight server version via the SDK's built-in getVersion API.
   * Chains the caller's abort signal and a timeout onto an internal controller
   * so the underlying request is cancelled on either trigger.
   */
  async getServerVersion(
    signal?: AbortSignal,
    timeoutMs: number = 5000
  ): Promise<{ success: boolean; version?: string; error?: string }> {
    const controller = new AbortController();
    let timedOut = false;

    // Chain external abort signal
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        abortHandler = () => controller.abort();
        signal.addEventListener("abort", abortHandler);
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const data = await this.client.getVersion({ signal: controller.signal });
      const version = typeof data.api_version === "string" ? data.api_version : undefined;
      if (!version) {
        return { success: false, error: "missing api_version" };
      }
      return { success: true, version };
    } catch (e) {
      // The SDK wraps fetch aborts in HindsightError, so rely on our controller
      // state (rather than error type) to distinguish timeout vs. cancellation.
      if (controller.signal.aborted) {
        if (timedOut) {
          return { success: false, error: `Operation timed out after ${timeoutMs}ms` };
        }
        return { success: false, error: "Operation cancelled" };
      }
      return { success: false, error: this.formatError(e) };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Retain content with timeout and optional abort signal.
   * Always uses retainBatch internally since the SDK's retain() doesn't support
   * the observation_scopes parameter.
   * TODO: Switch to SDK's retain() when it supports observation_scopes.
   */
  async retain(
    options: RetainOptions,
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const item: MemoryItemInput = {
        content: options.content,
        tags: options.tags,
        metadata: options.metadata,
        document_id: options.documentId,
        update_mode: options.updateMode,
        entities: options.entities,
        // null (config default) is not valid for the SDK; convert to undefined
        observation_scopes: options.observationScopes ?? undefined,
        timestamp: options.timestamp,
        context: options.context,
      };
      await this.withTimeout(
        this.client.retainBatch(this.config.bankId, [item], {
          async: true,
        }),
        timeoutMs,
        signal
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Retain multiple items in batch with timeout and optional abort signal.
   */
  async retainBatch(
    items: MemoryItemInput[],
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.withTimeout(
        this.client.retainBatch(this.config.bankId, items, {
          async: true,
        }),
        timeoutMs,
        signal
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Recall memories with timeout and optional abort signal.
   * The timeout defaults to the configured recallTimeoutMs (30000) — recall
   * against large banks can take 8-30s, so the old hard-coded 10s default
   * silently failed every turn. On timeout, `timedOut` is set so callers can
   * fall back to a cheaper degraded retrieval.
   */
  async recall(
    options: RecallOptions,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{
    success: boolean;
    response?: RecallResponse;
    error?: string;
    timedOut?: boolean;
  }> {
    try {
      const result = await this.withTimeout(
        this.client.recall(this.config.bankId, options.query, {
          tags: options.tags,
          tagsMatch: options.tagsMatch,
          tagGroups: options.tagGroups,
          types: options.types,
          budget: options.budget ?? this.config.autoRecallBudget,
          maxTokens: options.maxTokens ?? this.config.maxRecallTokens ?? undefined,
          includeEntities: true,
        }),
        timeoutMs ?? this.config.recallTimeoutMs,
        signal
      );

      return { success: true, response: result };
    } catch (e) {
      // withTimeout rejects with a plain Error("Operation timed out after Xms")
      // for timeouts. Detect on the raw error before formatError appends the
      // bank/url context, so callers can distinguish a timeout from other
      // failures (aborts reject with "Operation aborted" and never match).
      const timedOut = e instanceof Error && e.message.startsWith("Operation timed out");
      return { success: false, error: this.formatError(e), timedOut };
    }
  }

  /**
   * Reflect and generate a contextual answer using the bank's identity and memories.
   */
  async reflect(
    options: ReflectOptions,
    signal?: AbortSignal,
    timeoutMs: number = 90000
  ): Promise<{ success: boolean; response?: ReflectResponse; error?: string }> {
    try {
      // Note: unlike recall, we don't fall back to autoRecallBudget (which defaults to 'mid').
      // The Hindsight SDK defaults reflect budget to 'low' since reflect is much more expensive
      // (agentic loop with up to 10 iterations of multi-tool search + LLM calls).
      // Only override when the user explicitly sets a budget.
      const result = await this.withTimeout(
        this.client.reflect(this.config.bankId, options.query, {
          tags: options.tags,
          tagsMatch: options.tagsMatch,
          budget: options.budget,
        }),
        timeoutMs,
        signal
      );

      return { success: true, response: result };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Fetch the entity co-occurrence graph via the server's REST endpoint
   * (the SDK's HindsightClient has no graph methods, so this uses raw fetch
   * like healthCheck). Returns the top-N edges by weight (N = limit).
   */
  async getEntityGraph(
    options: { limit?: number; minCount?: number } = {},
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: EntityGraphResponse; error?: string }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.minCount !== undefined) params.set("min_count", String(options.minCount));
    const qs = params.toString();
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/entities/graph${qs ? `?${qs}` : ""}`;
    return this.fetchJson<EntityGraphResponse>(url, signal, timeoutMs);
  }

  /**
   * List entities via the server's REST endpoint (used for seed name
   * resolution when a seed is not present in the fetched graph window).
   */
  async getEntities(
    options: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: EntityListResponse; error?: string }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const qs = params.toString();
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/entities${qs ? `?${qs}` : ""}`;
    return this.fetchJson<EntityListResponse>(url, signal, timeoutMs);
  }

  /**
   * List operations via the server's REST endpoint (the SDK's HindsightClient
   * has no operations methods, so this uses raw fetch like getEntityGraph).
   * The `status` query param filters server-side (pending/processing/
   * completed/failed/cancelled).
   */
  async getOperations(
    options: { status?: string; limit?: number } = {},
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: OperationsListResponse; error?: string }> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/operations${qs ? `?${qs}` : ""}`;
    return this.fetchJson<OperationsListResponse>(url, signal, timeoutMs);
  }

  /**
   * Trigger consolidation via POST /consolidate. Always sends a JSON body
   * (bodyless POST behavior is unverified; the server accepts an empty
   * object). Returns the async operation id; deduplicated=true means an
   * existing pending task was reused.
   */
  async consolidate(
    options: { observationScopes?: string[][] } = {},
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: ConsolidationResponse; error?: string }> {
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/consolidate`;
    const body: { observation_scopes?: string[][] } = {};
    if (options.observationScopes !== undefined) {
      body.observation_scopes = options.observationScopes;
    }
    return this.fetchJson<ConsolidationResponse>(url, signal, timeoutMs, {
      method: "POST",
      body,
    });
  }

  /**
   * Retry failed consolidations via POST /consolidation/recover.
   * Returns the number of retried operations.
   */
  async recoverConsolidation(
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: RecoverConsolidationResponse; error?: string }> {
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/consolidation/recover`;
    return this.fetchJson<RecoverConsolidationResponse>(url, signal, timeoutMs, {
      method: "POST",
      body: {},
    });
  }

  /**
   * List memory units via GET /memories/list (the SDK's HindsightClient has
   * no curation methods, so this uses raw fetch like getOperations). An empty
   * `q` is treated as omitted — the server treats q= as a filter, not a
   * no-op. The `state` query param filters server-side (valid/invalidated).
   */
  async listMemories(
    options: { q?: string; state?: string; limit?: number } = {},
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: MemoryListResponse; error?: string }> {
    const params = new URLSearchParams();
    if (options.q !== undefined && options.q !== "") params.set("q", options.q);
    if (options.state !== undefined) params.set("state", options.state);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/memories/list${qs ? `?${qs}` : ""}`;
    return this.fetchJson<MemoryListResponse>(url, signal, timeoutMs);
  }

  /**
   * Curate a memory unit via PATCH /memories/{id}. The server records the
   * reason when state is invalidated and keeps it in the memory's history
   * when reverted. Returns the updated memory unit.
   */
  async updateMemory(
    memoryId: string,
    body: { state?: string; reason?: string },
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; response?: MemoryUnit; error?: string }> {
    const url = `${this.config.apiUrl}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/memories/${encodeURIComponent(memoryId)}`;
    return this.fetchJson<MemoryUnit>(url, signal, timeoutMs, {
      method: "PATCH",
      body,
    });
  }

  /**
   * Raw-fetch a JSON endpoint with Bearer auth, abort chaining, and a timeout.
   * Mirrors healthCheck's controller pattern so the underlying request is
   * actually cancelled on timeout/abort (withTimeout alone would leave it
   * dangling). Omits the Authorization header when no apiKey is configured
   * (LAN no-auth servers). `init` (4th param, after timeoutMs) adds POST
   * support: method + JSON body with Content-Type: application/json.
   */
  private async fetchJson<T>(
    url: string,
    signal?: AbortSignal,
    timeoutMs: number = 30000,
    init?: { method?: string; body?: unknown }
  ): Promise<{ success: boolean; response?: T; error?: string }> {
    const controller = new AbortController();
    let timedOut = false;

    // Chain external abort signal
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        abortHandler = () => controller.abort();
        signal.addEventListener("abort", abortHandler);
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }
      const fetchInit: RequestInit = { signal: controller.signal, headers };
      if (init?.method) {
        fetchInit.method = init.method;
      }
      if (init?.body !== undefined) {
        fetchInit.body = JSON.stringify(init.body);
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, fetchInit);

      if (response.ok) {
        const data = (await response.json()) as T;
        return { success: true, response: data };
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (timedOut) {
          return { success: false, error: `Operation timed out after ${timeoutMs}ms` };
        }
        return { success: false, error: "Operation cancelled" };
      }
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Wrap a promise with a timeout and optional abort signal.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      // Handle abort signal
      const abortHandler = () => {
        signal?.removeEventListener("abort", abortHandler);
        clearTimeout(timer);
        reject(new Error("Operation aborted"));
      };

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abortHandler);
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      signal?.addEventListener("abort", abortHandler);

      promise
        .then((result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortHandler);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortHandler);
          reject(error);
        });
    });
  }

  /**
   * Format error with details from HindsightError.
   */
  private formatError(e: unknown): string {
    if (e instanceof Error && e.message === "Operation aborted") {
      return "Operation cancelled";
    }
    if (e instanceof HindsightError) {
      // Message already includes details from validateResponse, just add status code and context
      const parts = [e.message];
      if (e.statusCode) parts.push(`(status ${e.statusCode})`);
      parts.push(`[bank=${this.config.bankId} url=${this.config.apiUrl}]`);
      return parts.join(" ");
    }
    return `${String(e)} [bank=${this.config.bankId} url=${this.config.apiUrl}]`;
  }
}
