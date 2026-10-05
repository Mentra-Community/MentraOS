import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findUserByEmail, isGotrueAdminConfigured } from "./gotrue.client";

type Mode = "ok" | "unavailable" | "malformed" | "neverEnds" | "hang";

let mode: Mode = "ok";
let requests = 0;
let users: Array<{ id: string; email: string }> = [];

const directory = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    requests++;
    const url = new URL(req.url);
    if (url.pathname !== "/auth/v1/admin/users") return new Response(null, { status: 404 });
    if (mode === "unavailable") return new Response(null, { status: 503 });
    if (mode === "hang") return new Promise<Response>(() => {});
    if (mode === "malformed") return Response.json({ users: "not a list" });
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    if (mode === "neverEnds") {
      const other = (i: number) => ({ id: `o-${page}-${i}`, email: `o-${page}-${i}@example.test` });
      return Response.json({ users: Array.from({ length: perPage }, (_, i) => other(i)) });
    }
    return Response.json({ users: users.slice((page - 1) * perPage, page * perPage) });
  },
});

const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeEach(() => {
  process.env.SUPABASE_URL = directory.url.origin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-directory-test-key";
  mode = "ok";
  requests = 0;
  users = [];
});

afterEach(() => {
  restore();
});

afterAll(() => {
  restore();
  directory.stop(true);
});

function restore() {
  if (saved.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
}

describe("isGotrueAdminConfigured", () => {
  test("needs both the project URL and the service-role key", () => {
    expect(isGotrueAdminConfigured()).toBe(true);
    delete process.env.SUPABASE_URL;
    expect(isGotrueAdminConfigured()).toBe(false);
    process.env.SUPABASE_URL = directory.url.origin;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isGotrueAdminConfigured()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "   ";
    expect(isGotrueAdminConfigured()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "key";
    process.env.SUPABASE_URL = "  ";
    expect(isGotrueAdminConfigured()).toBe(false);
  });
});

describe("findUserByEmail", () => {
  test("finds an exact email match across pages in both modes", async () => {
    users = Array.from({ length: 200 }, (_, i) => ({ id: `u-${i}`, email: `u-${i}@example.test` }));
    users.push({ id: "target", email: "Target@Example.test" });
    for (const options of [{}, { strict: true }]) {
      expect((await findUserByEmail("target@example.test", options))?.id).toBe("target");
      expect(await findUserByEmail("absent@example.test", options)).toBeNull();
    }
  });

  test("default mode keeps answering null when the directory cannot answer", async () => {
    mode = "unavailable";
    expect(await findUserByEmail("a@example.test")).toBeNull();
    mode = "neverEnds";
    requests = 0;
    expect(await findUserByEmail("a@example.test")).toBeNull();
    expect(requests).toBe(20);
  });

  test("strict mode throws on a non-200 answer", async () => {
    mode = "unavailable";
    await expect(findUserByEmail("a@example.test", { strict: true })).rejects.toThrow(/directory lookup failed/);
  });

  test("strict mode throws on a 200 whose body is not a user list", async () => {
    mode = "malformed";
    await expect(findUserByEmail("a@example.test", { strict: true })).rejects.toThrow(/directory lookup failed/);
  });

  test("strict mode throws when every page up to the scan limit is full", async () => {
    mode = "neverEnds";
    await expect(findUserByEmail("a@example.test", { strict: true })).rejects.toThrow(/directory lookup failed/);
    expect(requests).toBe(20);
  });

  test("strict mode throws when the request errors", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    await expect(findUserByEmail("a@example.test", { strict: true })).rejects.toThrow(/directory lookup failed/);
  });

  test("strict mode throws at the timeout when the directory hangs", async () => {
    mode = "hang";
    const started = Date.now();
    await expect(findUserByEmail("a@example.test", { strict: true, timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
