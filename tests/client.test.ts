/**
 * Unit tests for HindsightClientWrapper.
 * Covers healthCheck, retain, retainBatch, recall, reflect, withTimeout, and formatError.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { HindsightError } from "@vectorize-io/hindsight-client";
import { HindsightClientWrapper } from "../src/client";
import { testConfig } from "./fixtures";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Helper: create a fetch mock that respects AbortSignal.
 */
function createAbortAwareFetch(resolveWith?: object) {
  return mock((_url: string, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }

      if (signal) {
        const onAbort = () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (resolveWith) {
        resolve(resolveWith);
      }
    });
  });
}

/**
 * Helper: mock the internal HindsightClient methods on a wrapper instance.
 * Returns the original methods so they can be restored after the test.
 */
function mockSdkMethods(client: HindsightClientWrapper) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (client as any).client;
  const origGetVersion = sdk.getVersion.bind(sdk);
  const origRetainBatch = sdk.retainBatch.bind(sdk);
  const origRecall = sdk.recall.bind(sdk);
  const origReflect = sdk.reflect.bind(sdk);
  return { sdk, origGetVersion, origRetainBatch, origRecall, origReflect };
}

// ============================================
// healthCheck
// ============================================

describe("healthCheck", () => {
  it("returns { success: true } when server responds with OK", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: true, status: 200 })
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result).toEqual({ success: true });
  });

  it("returns { success: false, error: 'HTTP 500' } for non-OK response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: false, status: 500 })
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result).toEqual({ success: false, error: "HTTP 500" });
  });

  it("returns { success: false, error: 'Operation timed out...' } when timeout fires", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck(undefined, 100);

    expect(result).toEqual({ success: false, error: "Operation timed out after 100ms" });
  });

  it("returns { success: false, error: 'Operation cancelled' } when signal is aborted", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.healthCheck(controller.signal, 5000);
    expect(result).toEqual({ success: false, error: "Operation cancelled" });
  });

  it("returns { success: false, error: 'Operation cancelled' } when signal is already aborted", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const controller = new AbortController();
    controller.abort();

    const result = await client.healthCheck(controller.signal, 5000);
    expect(result).toEqual({ success: false, error: "Operation cancelled" });
  });

  it("returns network error message on fetch failure", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new TypeError("fetch failed")
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result.success).toBe(false);
    expect(result.error).toBe("fetch failed");
  });

  it("cleans up abort listener after success", async () => {
    const removeEventListenerSpy = mock();
    const signal = {
      aborted: false,
      addEventListener: mock(),
      removeEventListener: removeEventListenerSpy,
    } as unknown as AbortSignal;

    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const client = new HindsightClientWrapper(testConfig);
    await client.healthCheck(signal);

    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
  });

  it("cleans up abort listener after error", async () => {
    const removeEventListenerSpy = mock();
    const signal = {
      aborted: false,
      addEventListener: mock(),
      removeEventListener: removeEventListenerSpy,
    } as unknown as AbortSignal;

    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("network error")
    );

    const client = new HindsightClientWrapper(testConfig);
    await client.healthCheck(signal);

    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// getServerVersion
// ============================================

/**
 * Helper: create a getVersion mock that rejects when the supplied abort signal
 * fires (mirroring how the real SDK cancels an in-flight request on abort).
 */
function createAbortableGetVersion(resolveWith?: { api_version: string }) {
  return mock((opts?: { signal?: AbortSignal }) => {
    const signal = opts?.signal;
    return new Promise<{ api_version: string }>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new HindsightError("getVersion failed", undefined, new Error("aborted")));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new HindsightError("getVersion failed", undefined, new Error("aborted"))),
        { once: true }
      );
      if (resolveWith) resolve(resolveWith);
    });
  });
}

describe("getServerVersion", () => {
  it("returns { success, version } when getVersion returns api_version", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    sdk.getVersion = mock(() => Promise.resolve({ api_version: "0.8.3" }));

    const result = await client.getServerVersion();

    expect(result).toEqual({ success: true, version: "0.8.3" });
    sdk.getVersion = origGetVersion;
  });

  it("returns error when api_version is missing from the response", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    sdk.getVersion = mock(() => Promise.resolve({} as { api_version: string }));

    const result = await client.getServerVersion();

    expect(result.success).toBe(false);
    expect(result.error).toBe("missing api_version");
    sdk.getVersion = origGetVersion;
  });

  it("returns formatted error when getVersion throws HindsightError", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    sdk.getVersion = mock(() => Promise.reject(new HindsightError("getVersion failed", 503)));

    const result = await client.getServerVersion();

    expect(result.success).toBe(false);
    expect(result.error).toContain("getVersion failed");
    expect(result.error).toContain("503");
    expect(result.error).toContain("test-bank");
    sdk.getVersion = origGetVersion;
  });

  it("returns { success: false, error: 'Operation timed out...' } when timeout fires", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    sdk.getVersion = createAbortableGetVersion();

    const result = await client.getServerVersion(undefined, 100);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation timed out after 100ms");
    sdk.getVersion = origGetVersion;
  });

  it("returns { success: false, error: 'Operation cancelled' } when signal is aborted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    // No resolveWith: the request hangs until the abort signal fires.
    sdk.getVersion = createAbortableGetVersion();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.getServerVersion(controller.signal, 5000);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation cancelled");
    sdk.getVersion = origGetVersion;
  });

  it("returns formatted error on network failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origGetVersion } = mockSdkMethods(client);
    sdk.getVersion = mock(() =>
      Promise.reject(
        new HindsightError("getVersion failed", undefined, new TypeError("fetch failed"))
      )
    );

    const result = await client.getServerVersion();

    expect(result.success).toBe(false);
    expect(result.error).toContain("getVersion failed");
    expect(result.error).toContain("test-bank");
    sdk.getVersion = origGetVersion;
  });
});

// ============================================
// getEntityGraph / getEntities
// ============================================

describe("getEntityGraph", () => {
  it("fetches the entity graph with the bank id, query params, and Bearer auth", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({
          nodes: [],
          edges: [],
          total_entities: 0,
          total_edges: 0,
          limit: 0,
        }),
      })
    );

    const result = await client.getEntityGraph({ limit: 420, minCount: 5 });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://test.vectorize.io/v1/default/banks/test-bank/entities/graph?limit=420&min_count=5"
    );
    expect((init as { headers?: Record<string, string> }).headers?.Authorization).toBe(
      "Bearer test-key"
    );
  });

  it("omits the Authorization header when no apiKey is configured", async () => {
    const client = new HindsightClientWrapper({ ...testConfig, apiKey: "" });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ nodes: [], edges: [], total_entities: 0, total_edges: 0, limit: 0 }),
      })
    );

    await client.getEntityGraph();

    const init = fetchMock.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it("returns HTTP status error on non-OK responses", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: false, status: 500 })
    );

    const result = await client.getEntityGraph();

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 500");
  });

  it("returns a timeout error when the request exceeds the timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const result = await client.getEntityGraph({}, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation timed out after 50ms");
  });

  it("returns a cancelled error when the signal is aborted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.getEntityGraph({}, controller.signal, 5000);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation cancelled");
  });
});

describe("getEntities", () => {
  it("fetches the entity list with limit and offset", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
      })
    );

    const result = await client.getEntities({ limit: 500, offset: 0 });

    expect(result.success).toBe(true);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://test.vectorize.io/v1/default/banks/test-bank/entities?limit=500&offset=0"
    );
  });
});

// ============================================
// getOperations / consolidate / recoverConsolidation
// ============================================

describe("getOperations", () => {
  it("fetches operations with the status filter and limit", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({
          bank_id: "test-bank",
          total: 0,
          limit: 50,
          offset: 0,
          operations: [],
        }),
      })
    );

    const result = await client.getOperations({ status: "pending", limit: 50 });

    expect(result.success).toBe(true);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://test.vectorize.io/v1/default/banks/test-bank/operations?status=pending&limit=50"
    );
  });

  it("returns HTTP status error on non-OK responses", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: false, status: 500 })
    );

    const result = await client.getOperations();

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 500");
  });
});

describe("consolidate", () => {
  it("POSTs to /consolidate with a JSON body and Content-Type", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ operation_id: "op-1", deduplicated: false }),
      })
    );

    const result = await client.consolidate({ observationScopes: [["topic:a"]] });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://test.vectorize.io/v1/default/banks/test-bank/consolidate");
    const fetchInit = init as { method?: string; body?: string; headers?: Record<string, string> };
    expect(fetchInit.method).toBe("POST");
    expect(fetchInit.body).toBe(JSON.stringify({ observation_scopes: [["topic:a"]] }));
    expect(fetchInit.headers?.["Content-Type"]).toBe("application/json");
  });

  it("sends an empty JSON body when observationScopes is omitted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ operation_id: "op-2", deduplicated: true }),
      })
    );

    await client.consolidate();

    const init = fetchMock.mock.calls[0]![1] as { body?: string };
    expect(init.body).toBe("{}");
  });
});

describe("recoverConsolidation", () => {
  it("POSTs to /consolidation/recover and returns the retried count", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ retried_count: 3 }),
      })
    );

    const result = await client.recoverConsolidation();

    expect(result.success).toBe(true);
    expect(result.response?.retried_count).toBe(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://test.vectorize.io/v1/default/banks/test-bank/consolidation/recover");
    expect((init as { method?: string }).method).toBe("POST");
  });
});

describe("listMemories", () => {
  it("fetches memories with q, state, and limit query params", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      })
    );

    const result = await client.listMemories({ q: "dark mode", state: "valid", limit: 20 });

    expect(result.success).toBe(true);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://test.vectorize.io/v1/default/banks/test-bank/memories/list?q=dark+mode&state=valid&limit=20"
    );
  });

  it("treats an empty q as omitted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      })
    );

    await client.listMemories({ q: "", limit: 20 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://test.vectorize.io/v1/default/banks/test-bank/memories/list?limit=20");
  });

  it("returns HTTP status error on non-OK responses", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: false, status: 500 })
    );

    const result = await client.listMemories();

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 500");
  });
});

describe("updateMemory", () => {
  it("PATCHes the memory with a JSON body and Content-Type", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockImplementationOnce(
      createAbortAwareFetch({
        ok: true,
        status: 200,
        json: async () => ({
          id: "aaaaaaaa-1111-2222-3333-444444444444",
          text: "fact",
          state: "invalidated",
          date: "2026-09-02T12:00:00+00:00",
        }),
      })
    );

    const result = await client.updateMemory("aaaaaaaa-1111-2222-3333-444444444444", {
      state: "invalidated",
      reason: "stale",
    });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://test.vectorize.io/v1/default/banks/test-bank/memories/aaaaaaaa-1111-2222-3333-444444444444"
    );
    const fetchInit = init as { method?: string; body?: string; headers?: Record<string, string> };
    expect(fetchInit.method).toBe("PATCH");
    expect(fetchInit.body).toBe(JSON.stringify({ state: "invalidated", reason: "stale" }));
    expect(fetchInit.headers?.["Content-Type"]).toBe("application/json");
  });

  it("returns a timeout error when the request exceeds the timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const result = await client.updateMemory(
      "aaaaaaaa-1111-2222-3333-444444444444",
      { state: "valid" },
      undefined,
      50
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation timed out after 50ms");
  });

  it("returns a cancelled error when the signal is aborted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.updateMemory(
      "aaaaaaaa-1111-2222-3333-444444444444",
      { state: "valid" },
      controller.signal,
      5000
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation cancelled");
  });
});

// ============================================
// retain
// ============================================

describe("retain", () => {
  it("returns { success: true } on successful retain", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() =>
      Promise.resolve({ results: [{ documentId: "doc1", status: "ok" }] })
    );

    const result = await client.retain({
      content: "Test content",
      tags: ["test"],
      documentId: "test-doc",
      updateMode: "replace",
    });

    expect(result.success).toBe(true);
    expect(sdk.retainBatch).toHaveBeenCalled();
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on retain failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("retain failed")));

    const result = await client.retain({ content: "Test content" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("retain failed");
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => new Promise(() => {}));

    const result = await client.retain({ content: "Test content" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// retainBatch
// ============================================

describe("retainBatch", () => {
  it("returns { success: true } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() =>
      Promise.resolve({ results: [{ documentId: "doc1", status: "ok" }] })
    );

    const result = await client.retainBatch([]);

    expect(result.success).toBe(true);
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("batch failed")));

    const result = await client.retainBatch([]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("batch failed");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// recall
// ============================================

describe("recall", () => {
  it("returns { success: true, response } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    const mockResponse = { results: [{ id: "1", text: "Memory" }] };
    sdk.recall = mock(() => Promise.resolve(mockResponse));

    const result = await client.recall({ query: "test query" });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(mockResponse);
    sdk.recall = origRecall;
  });

  it("passes config defaults for budget and maxTokens", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.resolve({ results: [] }));

    await client.recall({ query: "test" });

    expect(sdk.recall).toHaveBeenCalled();
    const callOpts = (sdk.recall as unknown as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(callOpts.budget).toBe("mid");
    sdk.recall = origRecall;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.reject(new Error("recall failed")));

    const result = await client.recall({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("recall failed");
    sdk.recall = origRecall;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const result = await client.recall({ query: "test" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.recall = origRecall;
  });

  it("uses config.recallTimeoutMs as the default timeout", async () => {
    const client = new HindsightClientWrapper({ ...testConfig, recallTimeoutMs: 50 });
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const result = await client.recall({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out after 50ms");
    sdk.recall = origRecall;
  });

  it("does not set timedOut on non-timeout errors", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.reject(new Error("recall failed")));

    const result = await client.recall({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    sdk.recall = origRecall;
  });

  it("returns error on abort", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.recall({ query: "test" }, controller.signal, 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    sdk.recall = origRecall;
  });
});

// ============================================
// reflect
// ============================================

describe("reflect", () => {
  it("returns { success: true, response } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    const mockResponse = { text: "Based on memories..." };
    sdk.reflect = mock(() => Promise.resolve(mockResponse));

    const result = await client.reflect({ query: "test query" });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(mockResponse);
    sdk.reflect = origReflect;
  });

  it("does not override budget with config default (unlike recall)", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => Promise.resolve({ text: "result" }));

    await client.reflect({ query: "test" });

    expect(sdk.reflect).toHaveBeenCalled();
    const callOpts = (sdk.reflect as unknown as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(callOpts.budget).toBeUndefined();
    sdk.reflect = origReflect;
  });

  it("forwards includeFacts to the SDK reflect call", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => Promise.resolve({ text: "result" }));

    await client.reflect({ query: "test", includeFacts: true });

    const callOpts = (sdk.reflect as unknown as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(callOpts.includeFacts).toBe(true);
    sdk.reflect = origReflect;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => Promise.reject(new Error("reflect failed")));

    const result = await client.reflect({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reflect failed");
    sdk.reflect = origReflect;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => new Promise(() => {}));

    const result = await client.reflect({ query: "test" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.reflect = origReflect;
  });
});

// ============================================
// formatError (tested indirectly via failures above + directly here)
// ============================================

describe("formatError", () => {
  it("formats HindsightError with status code and bank info", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    const hindsightErr = new HindsightError("API error", 429);
    sdk.retainBatch = mock(() => Promise.reject(hindsightErr));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error");
    expect(result.error).toContain("429");
    expect(result.error).toContain("test-bank");
    sdk.retainBatch = origRetainBatch;
  });

  it("formats non-Error values with bank info", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject("string error"));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("string error");
    expect(result.error).toContain("test-bank");
    sdk.retainBatch = origRetainBatch;
  });

  it("formats 'Operation aborted' as 'Operation cancelled'", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("Operation aborted")));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation cancelled");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// withTimeout (tested indirectly via timeout tests above + directly here)
// ============================================

describe("withTimeout", () => {
  it("resolves before timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.resolve({ results: [] }));

    const result = await client.recall({ query: "fast" }, undefined, 5000);

    expect(result.success).toBe(true);
    sdk.recall = origRecall;
  });

  it("rejects with timeout when promise hangs", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const result = await client.recall({ query: "slow" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.recall = origRecall;
  });

  it("rejects immediately when signal is already aborted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const controller = new AbortController();
    controller.abort();

    const result = await client.recall({ query: "test" }, controller.signal, 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    sdk.recall = origRecall;
  });
});
