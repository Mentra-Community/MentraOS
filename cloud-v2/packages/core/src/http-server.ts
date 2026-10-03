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
  return Bun.serve({port, maxRequestBodySize: CORE_REQUEST_BODY_BYTES, async fetch(request) {
    if (!request.body || isFrameworkAssetUpload(request)) return fetch(request);
    const length = request.headers.get("content-length");
    if (length && !request.headers.has("transfer-encoding")) {
      if (Number(length) > CORE_ORDINARY_BODY_BYTES) {
        // Bun 1.3.14 must finish the HTTP body framing before responding, or
        // unread bytes can stall or corrupt the next keep-alive request.
        for await (const _chunk of request.body) { /* Discard without buffering. */ }
        return Response.json({error: "body_too_large"}, {status: 413});
      }
      return fetch(request);
    }
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CORE_ORDINARY_BODY_BYTES) {
          chunks.length = 0;
          while (!(await reader.read()).done) { /* Finish framing without retaining rejected bytes. */ }
          return Response.json({error: "body_too_large"}, {status: 413});
        }
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    return fetch(new Request(request, {body: new ReadableStream({start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }})}));
  }});
}
