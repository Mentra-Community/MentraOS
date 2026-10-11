/**
 * Reverse proxy from this site's `/api/*` to Core.
 *
 * Underscore-prefixed files are not routed by Cloudflare Pages, so this is a
 * plain module the route handler imports.
 *
 * Core's responses, including `Set-Cookie` and sign-in redirects (302 with
 * `Location`), are relayed unchanged (`redirect: "manual"`). The `Host` header
 * is dropped, and so is any `x-mentra-public-origin`: Core builds every
 * redirect and callback URL from its own configuration.
 */
export interface ProxyContext {
  request: Request;
  env: Record<string, string | undefined>;
}

export async function proxyToCore(context: ProxyContext): Promise<Response> {
  const coreUrl = context.env.CORE_URL ?? context.env.BUN_PUBLIC_CORE_URL;
  if (!coreUrl) {
    return Response.json(
      { error: "server_error", error_description: "CORE_URL is not configured" },
      { status: 500 },
    );
  }

  const sourceUrl = new URL(context.request.url);
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
