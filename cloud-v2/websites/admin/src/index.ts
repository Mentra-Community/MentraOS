import { serve } from "bun";
import { relative, resolve } from "node:path";

const storeUrl = process.env.STORE_URL ?? process.env.BUN_PUBLIC_STORE_URL ?? "http://localhost:3003";
const distRoot = resolve(import.meta.dir, "../dist");
const indexFile = Bun.file(resolve(distRoot, "index.html"));

async function proxyCoreRequest(req: Request) {
  const sourceUrl = new URL(req.url);
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, storeUrl);
  const headers = new Headers(req.headers);
  headers.delete("host");

  return fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
}

const server = serve({
  port: process.env.PORT ? Number(process.env.PORT) : 5174,
  routes: {
    "/api/*": proxyCoreRequest,
    "/*": serveBuiltApp,
  },
});

console.log(`Admin running at ${server.url}`);
console.log(`Proxying Store admin APIs to ${storeUrl}`);

async function serveBuiltApp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/") {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      // Malformed percent-encoding in the path.
      return new Response("Bad Request", { status: 400, headers: { "content-type": "text/plain" } });
    }
    const asset = resolve(distRoot, `.${decodedPath}`);
    if (isInsideDist(asset)) {
      const file = Bun.file(asset);
      if (await file.exists()) return new Response(file);
    }
  }

  if (!(await indexFile.exists())) {
    return new Response("Admin build missing. Run bun run build in websites/admin.", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(indexFile);
}

function isInsideDist(filePath: string): boolean {
  const rel = relative(distRoot, filePath);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}
