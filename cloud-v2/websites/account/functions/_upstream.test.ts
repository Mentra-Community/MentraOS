import { afterEach, expect, test } from "bun:test";
import routes from "../public/_routes.json";
import { isRelayedPath, relayToCore } from "./_upstream";

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

const env = { CORE_URL: "https://core.dev.test" };
const staticPage = new Response("<!doctype html>", { status: 200 });
const context = (request: Request) => ({ request, env, next: async () => staticPage });

test("relays exactly the provider's routes and the password reset calls; everything else is the static page", () => {
  for (const path of [
    "/.well-known/openid-configuration",
    "/.well-known/jwks.json",
    "/oidc/auth",
    "/oidc/token",
    "/oidc/session/end/confirm",
    "/interaction/uid-1/supabase",
    "/interaction/callback/workforce",
    "/api/account/password/forgot",
    "/api/account/password/reset",
  ]) {
    expect(isRelayedPath(path)).toBe(true);
  }
  for (const path of ["/", "/login", "/consent", "/signout", "/api/account/login", "/api/admin/me", "/.well-known/other", "/oidc"]) {
    expect(isRelayedPath(path)).toBe(false);
  }
});

test("the Pages routes file sends the same paths to the Function", () => {
  expect(routes.include.sort()).toEqual(
    [
      "/.well-known/openid-configuration",
      "/.well-known/jwks.json",
      "/oidc/*",
      "/interaction/*",
      "/api/account/password/forgot",
      "/api/account/password/reset",
    ].sort(),
  );
});

test("a static path is served without calling Core", async () => {
  const seen = capture(new Response("{}"));
  const response = await relayToCore(context(new Request("https://account.dev.test/login?interaction=x")));
  expect(response).toBe(staticPage);
  expect(seen).toHaveLength(0);
});

test("the provider's cookies and redirects pass through unchanged, so they stay first-party on this origin", async () => {
  capture(
    new Response(null, {
      status: 303,
      headers: [
        ["location", "https://account.dev.test/interaction/uid-1"],
        ["set-cookie", "__Secure-mentra_oidc_interaction=a; path=/interaction/uid-1; secure; samesite=lax; httponly"],
        ["set-cookie", "__Secure-mentra_oidc_interaction.sig=b; path=/interaction/uid-1; secure; samesite=lax; httponly"],
      ],
    }),
  );
  const response = await relayToCore(context(new Request("https://account.dev.test/oidc/auth?client_id=x")));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://account.dev.test/interaction/uid-1");
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.getSetCookie().some((line) => /domain=/i.test(line))).toBe(false);
});

test("forwards path, query, cookies, Origin and the body to Core, without Host or x-mentra-public-origin", async () => {
  const seen = capture(new Response("{}"));
  await relayToCore(
    context(
      new Request("https://account.dev.test/interaction/uid-1/supabase?x=1", {
        method: "POST",
        body: JSON.stringify({ access_token: "t" }),
        headers: {
          cookie: "__Secure-mentra_oidc_interaction=a",
          origin: "https://account.dev.test",
          host: "account.dev.test",
          "x-mentra-public-origin": "https://evil.test",
          "content-type": "application/json",
        },
      }),
    ),
  );
  expect(seen[0]!.url).toBe("https://core.dev.test/interaction/uid-1/supabase?x=1");
  expect(seen[0]!.redirect).toBe("manual");
  expect(seen[0]!.method).toBe("POST");
  expect(await seen[0]!.text()).toBe('{"access_token":"t"}');
  expect(seen[0]!.headers.get("cookie")).toBe("__Secure-mentra_oidc_interaction=a");
  expect(seen[0]!.headers.get("origin")).toBe("https://account.dev.test");
  expect(seen[0]!.headers.has("x-mentra-public-origin")).toBe(false);
  expect(seen[0]!.headers.get("host")).not.toBe("account.dev.test");
});

test("without CORE_URL the relay answers 500, no-store", async () => {
  const response = await relayToCore({ request: new Request("https://account.dev.test/oidc/auth"), env: {}, next: async () => staticPage });
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
