import { serve } from "@hono/node-server";
import { relative, resolve } from "node:path";

const coreUrl = process.env.CORE_URL ?? process.env.BUN_PUBLIC_CORE_URL ?? "http://localhost:3000";
const distRoot = resolve(import.meta.dir, "../dist");
const indexFile = Bun.file(resolve(distRoot, "index.html"));

async function proxyCoreRequest(req: Request, upstreamCoreUrl: string) {
  const sourceUrl = new URL(req.url);
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, upstreamCoreUrl);
  const headers = new Headers(req.headers);
  headers.delete("host");

  const response = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });

  // Core's Bun server also drops Content-Length on streaming S3 responses.
  // Restore only the exact length already described by a valid identity range
  // on the authenticated evidence endpoint; keep the body streaming.
  if (/^\/api\/admin\/test-runs\/[^/]+\/assets\/[^/]+$/.test(sourceUrl.pathname)
    && response.status === 206 && !response.headers.has("content-length")
    && [null, "identity"].includes(response.headers.get("content-encoding"))) {
    const match = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (match) {
      const [start, end, total] = match.slice(1).map(Number);
      if ([start, end, total].every(Number.isSafeInteger) && start >= 0 && start <= end && end < total) {
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete("transfer-encoding");
        responseHeaders.set("content-length", String(end - start + 1));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
      }
    }
  }
  return response;
}

export function startAdminServer(options: { coreUrl?: string; hostname?: string; port?: number } = {}) {
  // Bun.serve removes Content-Length from proxied streams, including Safari's
  // initial media range probe. The Node HTTP adapter preserves it without buffering.
  return serve({
    hostname: options.hostname ?? process.env.HOSTNAME ?? "0.0.0.0",
    port: options.port ?? (process.env.PORT ? Number(process.env.PORT) : 5174),
    overrideGlobalObjects: false,
    fetch: (req) => new URL(req.url).pathname.startsWith("/api/")
      ? proxyCoreRequest(req, options.coreUrl ?? coreUrl)
      : serveBuiltApp(req),
  });
}

if (import.meta.main) {
  const server = startAdminServer();
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`Admin listening on port ${address.port}`);
    console.log(`Proxying /api/* to ${coreUrl}`);
  });
}

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
