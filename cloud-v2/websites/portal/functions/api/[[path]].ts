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
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, coreUrl);
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  headers.set("x-mentra-public-origin", sourceUrl.origin);

  return fetch(upstreamUrl, {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
}
