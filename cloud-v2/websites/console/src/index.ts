import { serve } from "bun";
import index from "./index.html";

const coreUrl = process.env.CORE_URL ?? process.env.BUN_PUBLIC_CORE_URL ?? "http://localhost:3000";

async function proxyCoreRequest(req: Request) {
  const sourceUrl = new URL(req.url);
  const upstreamUrl = new URL(sourceUrl.pathname + sourceUrl.search, coreUrl);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // Match the deployed Pages proxy so local /api/* auth redirects target the
  // correct origin instead of falling back to CORE_URL.
  headers.set("x-mentra-public-origin", sourceUrl.origin);

  return fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
}

const server = serve({
  port: process.env.PORT ? Number(process.env.PORT) : 5173,
  routes: {
    "/api/*": proxyCoreRequest,
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`Console running at ${server.url}`);
console.log(`Proxying /api/* to ${coreUrl}`);
