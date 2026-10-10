import { describe, expect, spyOn, test } from "bun:test";

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
  test("a pre-aborted request skips authentication and fetch for JSON and form requests", async () => {
    const controller = new AbortController();
    const reason = new Error("collection deadline reached");
    controller.abort(reason);
    let tokenCalls = 0;
    let fetchCalls = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      getToken: async () => {
        tokenCalls += 1;
        return "token-123";
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });

    const options = { signal: controller.signal };
    await expect(http.get("/api/health", options)).rejects.toBe(reason);
    await expect(http.postForm("/api/artifacts", new FormData(), options)).rejects.toBe(reason);
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("an abort during authentication prevents the subsequent fetch", async () => {
    const controller = new AbortController();
    const reason = new Error("collection deadline reached");
    let resolveToken!: (token: string) => void;
    let tokenStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      tokenStarted = resolve;
    });
    let fetchCalls = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      getToken: () => {
        tokenStarted();
        return new Promise<string>((resolve) => {
          resolveToken = resolve;
        });
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });
    const result = http.get("/api/health", { signal: controller.signal }).catch((error) => error);
    await started;
    controller.abort(reason);
    resolveToken("token-123");

    expect(await result).toBe(reason);
    expect(fetchCalls).toBe(0);
  });

  test("passes the signal to pending fetch and never retries cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("collection deadline reached");
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let fetchCalls = 0;
    let retryTimers = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      timers: {
        ...systemTimers,
        setTimeout() {
          retryTimers += 1;
          return {};
        },
      },
      fetch: (_url, init) => {
        fetchCalls += 1;
        expect(init?.signal).toBe(controller.signal);
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
          fetchStarted();
        });
      },
    });
    const result = http.get("/api/health", { signal: controller.signal }).catch((error) => error);
    await started;
    controller.abort(reason);

    expect(await result).toBe(reason);
    expect(fetchCalls).toBe(1);
    expect(retryTimers).toBe(0);
  });

  test("does not retry a transport AbortError even without an aborted signal", async () => {
    const reason = new DOMException("request cancelled", "AbortError");
    let fetchCalls = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      fetch: async () => {
        fetchCalls += 1;
        throw reason;
      },
    });

    await expect(http.get("/api/health")).rejects.toBe(reason);
    expect(fetchCalls).toBe(1);
  });

  test("an abort during retry backoff clears its timer and listener before any further fetch", async () => {
    const controller = new AbortController();
    const reason = new Error("collection deadline reached");
    const addListener = spyOn(controller.signal, "addEventListener");
    const removeListener = spyOn(controller.signal, "removeEventListener");
    const handle = { kind: "http-retry" };
    const cleared: unknown[] = [];
    let onTimer!: () => void;
    let timerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      timerStarted = resolve;
    });
    let fetchCalls = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      timers: {
        ...systemTimers,
        setTimeout(callback, delayMs) {
          expect(delayMs).toBe(250);
          onTimer = callback;
          timerStarted();
          return handle;
        },
        clearTimeout(timer) {
          cleared.push(timer);
        },
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new TypeError("connection reset");
      },
    });

    try {
      const result = http.get("/api/health", { signal: controller.signal }).catch((error) => error);
      await started;
      controller.abort(reason);
      expect(await result).toBe(reason);
      onTimer();
      await Promise.resolve();

      expect(fetchCalls).toBe(1);
      expect(cleared).toEqual([handle]);
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener.mock.calls[0]?.[1]).toBe(addListener.mock.calls[0]?.[1]);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  test("a completed retry delay removes its abort listener and preserves safe retries", async () => {
    const controller = new AbortController();
    const addListener = spyOn(controller.signal, "addEventListener");
    const removeListener = spyOn(controller.signal, "removeEventListener");
    let fetchCalls = 0;
    const http = createHttpClient({
      baseUrl: "https://core.test",
      logger,
      timers: {
        ...systemTimers,
        setTimeout(callback) {
          callback();
          return {};
        },
      },
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new TypeError("connection reset");
        return new Response('{"ok":true}');
      },
    });

    try {
      await expect(http.get("/api/health", { signal: controller.signal })).resolves.toEqual({ ok: true });
      expect(fetchCalls).toBe(2);
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener.mock.calls[0]?.[1]).toBe(addListener.mock.calls[0]?.[1]);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  test.each([200, 400])(
    "an abort while reading a %i response does not return parsed data or HttpError",
    async (status) => {
      const controller = new AbortController();
      const reason = new Error("collection deadline reached");
      let resolveBody!: (body: string) => void;
      let readingStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        readingStarted = resolve;
      });
      const response = new Response("", { status });
      const readBody = () => {
        readingStarted();
        return new Promise<string>((resolve) => {
          resolveBody = resolve;
        });
      };
      Object.defineProperties(response, {
        text: {value: readBody},
        json: {value: async () => JSON.parse(await readBody())},
      });
      const http = createHttpClient({ baseUrl: "https://core.test", logger, fetch: async () => response });
      const result = http.get("/api/health", { signal: controller.signal }).catch((error) => error);
      await started;
      controller.abort(reason);
      resolveBody('{"ok":true}');

      expect(await result).toBe(reason);
    },
  );

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
