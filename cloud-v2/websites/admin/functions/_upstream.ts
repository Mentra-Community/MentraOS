/**
 * Shared reverse proxy for the admin site's API routes.
 *
 * Underscore-prefixed files are not routed by Cloudflare Pages, so this is a
 * plain module the route handlers import.
 */
export interface ProxyContext {
  request: Request
  env: Record<string, string | undefined>
}

/** Proxy the request to `upstreamUrl`, preserving path, query, method and body. */
export async function proxyTo(context: ProxyContext, upstreamUrl: string | undefined, label: string): Promise<Response> {
  if (!upstreamUrl) {
    return Response.json({error: "server_error", error_description: `${label} is not configured`}, {status: 500})
  }

  const sourceUrl = new URL(context.request.url)
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, upstreamUrl)
  const headers = new Headers(context.request.headers)
  headers.delete("host")
  headers.set("x-mentra-public-origin", sourceUrl.origin)

  const method = context.request.method
  return fetch(targetUrl, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  })
}

export function storeUpstream(env: ProxyContext["env"]): string | undefined {
  return env.STORE_URL ?? env.BUN_PUBLIC_STORE_URL
}

export function coreUpstream(env: ProxyContext["env"]): string | undefined {
  return env.CORE_URL ?? env.BUN_PUBLIC_CORE_URL
}
