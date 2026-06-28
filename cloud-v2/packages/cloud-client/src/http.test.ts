import { describe, expect, test } from "bun:test";

import { HttpError } from "./errors";
import { createHttpClient } from "./http";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("createHttpClient", () => {
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
        await http.post("/api/client/incidents", {});
        throw new Error("expected request to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpError = err as HttpError;
        expect(httpError.status).toBe(400);
        expect(httpError.code).toBe("invalid_request");
        expect(httpError.message).toBe(
          "HTTP 400 on POST /api/client/incidents: request body must be a JSON object",
        );
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
