export async function onRequest(context: {
  request: Request;
  env: { CORE_URL?: string; BUN_PUBLIC_CORE_URL?: string };
}): Promise<Response> {
  const coreUrl = context.env.CORE_URL ?? context.env.BUN_PUBLIC_CORE_URL;
  if (!coreUrl) {
    return Response.json(
      { error: "server_error", error_description: "CORE_URL is not configured" },
      { status: 500 },
    );
  }

  const sourceUrl = new URL(context.request.url);
  // Preserve any path prefix configured on CORE_URL by resolving a relative
  // path (strip the leading "/") against a normalized base ending in "/".
  const base = new URL(coreUrl);
  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const upstreamUrl = new URL(`.${sourceUrl.pathname}${sourceUrl.search}`, base);
  const headers = new Headers(context.request.headers);
  stripForwardingAndHopByHopHeaders(headers);
  headers.delete("host");
  headers.set("x-mentra-public-origin", sourceUrl.origin);

  return fetch(upstreamUrl, {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
}

// Client-supplied forwarding/hop-by-hop headers must never reach CORE_URL: they
// would let a request spoof trusted proxy metadata (client IP, protocol, host).
// The edge sets its own trusted values (e.g. x-mentra-public-origin) after this.
const FORWARDING_AND_HOP_BY_HOP_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-mentra-public-origin",
];

function stripForwardingAndHopByHopHeaders(headers: Headers): void {
  // Per RFC 7230 §6.1 the inbound `Connection` header may name additional
  // hop-by-hop headers (e.g. `Connection: X-Foo, close`); strip those too so
  // client-controlled proxy metadata never reaches CORE_URL. Read it before the
  // static loop deletes `connection` itself. Tokens are client-controlled, so
  // keep only valid HTTP field-names (RFC 7230 token) — Headers.delete throws on
  // a malformed name, which would otherwise turn this proxy into a 500.
  const isValidHeaderName = (name: string) => /^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name);
  const connectionTokens =
    headers
      .get("connection")
      ?.split(",")
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length > 0 && isValidHeaderName(token)) ?? [];

  for (const name of [...FORWARDING_AND_HOP_BY_HOP_HEADERS, ...connectionTokens]) {
    headers.delete(name);
  }
}
