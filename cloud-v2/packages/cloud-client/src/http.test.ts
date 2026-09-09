import { describe, expect, test } from "bun:test";

import { HttpError } from "./errors";
import { createHttpClient } from "./http";
import { systemTimers, type CloudClientTimers } from "./timers";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("createHttpClient", () => {
  test("uses the injected scheduler for retry backoff", async () => {
    const scheduledDelays: number[] = [];
    const timers: CloudClientTimers = {
      ...systemTimers,
      setTimeout(callback, delayMs) {
        scheduledDelays.push(delayMs);
        callback();
        return { kind: "http-retry" };
      },
    };
    let calls = 0;
    const http = createHttpClient({
      baseUrl: "https://runtime.test",
      logger,
      timers,
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection reset");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(http.get("/api/health")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(scheduledDelays).toEqual([250]);
  });

  test("maps RFC OAuth error bodies to HttpError code and detail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "request body must be a JSON object",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const http = createHttpClient({ baseUrl: "https://core.test", logger });
      try {
        await http.post("/api/client/reports", {});
        throw new Error("expected request to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpError = err as HttpError;
        expect(httpError.status).toBe(400);
        expect(httpError.code).toBe("invalid_request");
        expect(httpError.message).toBe(
          "HTTP 400 on POST /api/client/reports: request body must be a JSON object",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("postForm goes through the shared retry core: no Content-Type, POST not retried by default", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ headers: Record<string, string>; body: unknown }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      });
      throw new TypeError("network down");
    }) as unknown as typeof fetch;

    try {
      const http = createHttpClient({
        baseUrl: "https://core.test",
        getToken: async () => "token-123",
        logger,
      });
      const form = new FormData();
      form.append("files", new Blob(["x"]), "s.jpg");

      try {
        await http.postForm("/api/client/reports/rep_1/artifacts", form);
        throw new Error("expected request to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).code).toBe("NETWORK_ERROR");
      }

      // POST is not idempotent, so the transient failure is not retried.
      expect(seen).toHaveLength(1);
      // fetch/FormData must generate the multipart boundary itself.
      expect(seen[0].headers["Content-Type"]).toBeUndefined();
      expect(seen[0].headers["Authorization"]).toBe("Bearer token-123");
      expect(seen[0].body).toBe(form);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("postForm retries transient network failures when marked idempotent", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return new Response(JSON.stringify({ stored: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const http = createHttpClient({ baseUrl: "https://core.test", logger });
      const result = await http.postForm(
        "/api/client/reports/rep_1/artifacts",
        new FormData(),
        { idempotent: true },
      );
      expect(result).toEqual({ stored: 1 });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("postForm maps non-2xx responses to HttpError like JSON requests", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "request body exceeds 53477376 bytes",
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const http = createHttpClient({ baseUrl: "https://core.test", logger });
      try {
        await http.postForm("/api/client/reports/rep_1/artifacts", new FormData());
        throw new Error("expected request to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpError = err as HttpError;
        expect(httpError.status).toBe(413);
        expect(httpError.code).toBe("invalid_request");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the older code/message error body mapping", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "NOT_FOUND",
          message: "bundle missing",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const http = createHttpClient({ baseUrl: "https://core.test", logger });
      try {
        await http.get("/api/client/miniapps/demo/bundle");
        throw new Error("expected request to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpError = err as HttpError;
        expect(httpError.status).toBe(404);
        expect(httpError.code).toBe("NOT_FOUND");
        expect(httpError.message).toBe(
          "HTTP 404 on GET /api/client/miniapps/demo/bundle: bundle missing",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
