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
