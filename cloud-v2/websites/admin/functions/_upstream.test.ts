import { afterEach, expect, test } from "bun:test";
import { proxyToCore } from "./_upstream";

const savedFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = savedFetch;
});

function capture(response: Response) {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return response;
  }) as typeof fetch;
  return seen;
}

test("the relay passes Set-Cookie and a 302 Location unchanged", async () => {
  const upstream = new Response(null, {
    status: 302,
    headers: [
      ["location", "https://account.dev.mentraglass.com/oidc/auth?client_id=x"],
      ["set-cookie", "__Host-mentra_client_tx=abc; Path=/; HttpOnly; Secure; SameSite=Lax"],
      ["set-cookie", "__Host-mentra_admin_session=def; Path=/; HttpOnly; Secure; SameSite=Lax"],
    ],
  });
  capture(upstream);
  const response = await proxyToCore({
    request: new Request("https://site.test/api/admin/auth/login?return_to=%2F"),
    env: { CORE_URL: "https://core.test" },
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://account.dev.mentraglass.com/oidc/auth?client_id=x");
  expect(response.headers.getSetCookie()).toHaveLength(2);
});

test("the relay forwards path, query and cookies to Core, without Host or x-mentra-public-origin", async () => {
  const seen = capture(new Response("{}"));
  await proxyToCore({
    request: new Request("https://site.test/api/admin/auth/callback?code=c&state=s", {
      headers: { cookie: "__Host-mentra_client_tx=abc", host: "site.test", "x-mentra-public-origin": "https://evil.test" },
    }),
    env: { CORE_URL: "https://core.test" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("https://core.test/api/admin/auth/callback?code=c&state=s");
  expect(seen[0]!.redirect).toBe("manual");
  expect(seen[0]!.headers.get("cookie")).toBe("__Host-mentra_client_tx=abc");
  expect(seen[0]!.headers.has("x-mentra-public-origin")).toBe(false);
  expect(seen[0]!.headers.get("host")).not.toBe("site.test");
});

test("a POST body is forwarded", async () => {
  const seen = capture(new Response("{}"));
  await proxyToCore({
    request: new Request("https://site.test/api/admin/auth/logout", { method: "POST", body: "{}", headers: { origin: "https://site.test" } }),
    env: { CORE_URL: "https://core.test" },
  });
  expect(seen[0]!.method).toBe("POST");
  expect(seen[0]!.headers.get("origin")).toBe("https://site.test");
  expect(await seen[0]!.text()).toBe("{}");
});

test("a missing CORE_URL answers 500", async () => {
  const response = await proxyToCore({ request: new Request("https://site.test/api/x"), env: {} });
  expect(response.status).toBe(500);
});
