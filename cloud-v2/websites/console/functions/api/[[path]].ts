type PagesContext = {
  request: Request;
  env: {
    CORE_URL?: string;
  };
};

export async function onRequest(context: PagesContext): Promise<Response> {
  const coreUrl = context.env.CORE_URL;

  if (!coreUrl) {
    return Response.json({ error: "CORE_URL is not configured for this Pages environment" }, { status: 503 });
  }

  const sourceUrl = new URL(context.request.url);
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, coreUrl);
  const headers = new Headers(context.request.headers);
  headers.delete("host");

  return fetch(upstreamUrl, {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
}
