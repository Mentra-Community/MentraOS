import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api, ApiError } from "./api";

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

function stubFetch(response: Response) {
  const spy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  restore.push(() => spy.mockRestore());
  return spy;
}

describe("admin api helper", () => {
  test("parses a JSON success", async () => {
    stubFetch(Response.json({ ok: true }));
    expect(await api<{ ok: boolean }>("/api/x")).toEqual({ ok: true });
  });

  test("a 204 answers undefined instead of failing to parse an empty body", async () => {
    const spy = stubFetch(new Response(null, { status: 204 }));
    expect(await api<void>("/api/organization/credentials/cred_1", { method: "DELETE" })).toBeUndefined();
    expect(spy.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
  });

  test("a failure carries the status and the server's description", async () => {
    stubFetch(Response.json({ error: "forbidden", error_description: "not allowed" }, { status: 403 }));
    const error = await api("/api/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe("not allowed");
    expect((error as ApiError).code).toBe("forbidden");
  });

  test("a failure with no description keeps the status line, and the code when there is one", async () => {
    stubFetch(Response.json({ error: "user_not_found" }, { status: 404, statusText: "Not Found" }));
    const error = (await api("/api/x").catch((caught: unknown) => caught)) as ApiError;
    expect(error.message).toBe("404 Not Found");
    expect(error.code).toBe("user_not_found");

    stubFetch(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    const html = (await api("/api/x").catch((caught: unknown) => caught)) as ApiError;
    expect(html.message).toBe("502 Bad Gateway");
    expect(html.code).toBeUndefined();
  });
});

afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });
let restoreFetch: (() => void) | undefined;

function pendingResponse(bodyOnly = false) {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_path, options) => {
    const pending = new Promise<never>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {once: true});
    });
    return bodyOnly ? {ok: true, json: () => pending} as unknown as Response : pending;
  }) as typeof fetch);
  restoreFetch = () => fetchMock.mockRestore();
}

test("API timeout ends both a pending request and a pending response body", async () => {
  for (const bodyOnly of [false, true]) {
    pendingResponse(bodyOnly);
    await expect(api("/history", {timeoutMs: 10})).rejects.toThrow("Request timed out. Please try again.");
    restoreFetch!();
  }
});

test("query cancellation remains cancellation rather than a timeout", async () => {
  pendingResponse();
  const controller = new AbortController();
  const result = api("/history", {signal: controller.signal, timeoutMs: 1000});
  controller.abort(new DOMException("Query cancelled", "AbortError"));
  await expect(result).rejects.toThrow("Query cancelled");
});
