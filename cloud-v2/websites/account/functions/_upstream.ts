/**
 * The sign-in site's relay to its environment's Core.
 *
 * Core's sign-in server (its OpenID Connect provider) has its issuer at this
 * site's origin, and its routes run in Core. This relay forwards exactly those
 * routes, so the provider's cookies are first-party on this origin and its
 * redirects come back here:
 *  - `/.well-known/openid-configuration` and `/.well-known/jwks.json`;
 *  - `/oidc/*`: authorization, token, revocation, end-session and userinfo;
 *  - `/interaction/*`: the provider's sign-in steps;
 *  - `/api/account/password/forgot` and `/api/account/password/reset`:
 *    password reset through Core's account API.
 * Everything else is the static sign-in page.
 *
 * Core's responses, including every `Set-Cookie` and redirect (`Location`),
 * are relayed unchanged (`redirect: "manual"`). The `Host` header and
 * `x-mentra-public-origin` are dropped; Core builds every URL from its
 * configured issuer.
 *
 * Underscore-prefixed files are not routed by Cloudflare Pages, so this is a
 * plain module that `_middleware.ts` imports.
 */
export interface RelayContext {
  request: Request;
  env: Record<string, string | undefined>;
  next: () => Promise<Response>;
}

const RELAYED_PATHS = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/jwks.json",
  "/api/account/password/forgot",
  "/api/account/password/reset",
]);
const RELAYED_PREFIXES = ["/oidc/", "/interaction/"];

export function isRelayedPath(pathname: string): boolean {
  return RELAYED_PATHS.has(pathname) || RELAYED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function relayToCore(context: RelayContext): Promise<Response> {
  const sourceUrl = new URL(context.request.url);
  if (!isRelayedPath(sourceUrl.pathname)) return context.next();

  const coreUrl = context.env.CORE_URL;
  if (!coreUrl) {
    return Response.json(
      { error: "server_error", error_description: "CORE_URL is not configured" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, coreUrl);
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  headers.delete("x-mentra-public-origin");

  const method = context.request.method;
  return fetch(upstreamUrl, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
}
