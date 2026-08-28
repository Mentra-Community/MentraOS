export async function onRequest(context: {
  request: Request;
  env: { STORE_URL?: string; BUN_PUBLIC_STORE_URL?: string };
}): Promise<Response> {
  const storeUrl = context.env.STORE_URL ?? context.env.BUN_PUBLIC_STORE_URL;
  if (!storeUrl) {
    return Response.json(
      { error: "server_error", error_description: "STORE_URL is not configured" },
      { status: 500 },
    );
  }

  const sourceUrl = new URL(context.request.url);
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, storeUrl);
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
