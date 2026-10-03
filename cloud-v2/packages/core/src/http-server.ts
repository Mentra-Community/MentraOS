import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {frameworkIdentitySchema} from "./types/framework-request.types";

/** Only authenticated framework asset PUTs need the larger streaming ceiling. */
export const CORE_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;
export const CORE_ORDINARY_BODY_BYTES = 128 * 1024 * 1024;

function isFrameworkAssetUpload(request: Request): boolean {
  if (request.method !== "PUT") return false;
  const match = new URL(request.url).pathname.match(/^\/api\/internal\/framework-results\/([^/]+)\/assets\/([^/]+)$/);
  if (!match) return false;
  try {return match.slice(1).every(value => frameworkIdentitySchema.safeParse(decodeURIComponent(value)).success);}
  catch {return false;}
}

export function serveCore(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  const app = new Hono();
  const ordinaryLimit = bodyLimit({maxSize: CORE_ORDINARY_BODY_BYTES, onError: c => c.json({error: "body_too_large"}, 413)});
  app.use("*", (c, next) => isFrameworkAssetUpload(c.req.raw) ? next() : ordinaryLimit(c, next));
  app.all("*", c => fetch(c.req.raw));
  return Bun.serve({port, maxRequestBodySize: CORE_REQUEST_BODY_BYTES, fetch: app.fetch});
}
