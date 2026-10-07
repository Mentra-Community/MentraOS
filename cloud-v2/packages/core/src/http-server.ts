import {frameworkAssetIdSchema} from "./types/framework-run.types";
import {frameworkIdentitySchema} from "./types/framework-request.types";

/** Only authenticated framework asset PUTs need the larger streaming ceiling. */
export const CORE_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;
export const CORE_ORDINARY_BODY_BYTES = 128 * 1024 * 1024;
/** Allow bounded storage, Mongo and incident work to finish before sending its acknowledgement. */
export const CORE_HTTP_IDLE_TIMEOUT_SECONDS = 60;

/** Keep dependencies alive until admitted HTTP requests finish, even on repeated signals. */
export function createCoreStop(server: {stop(): Promise<void>}, disconnect: () => Promise<void>): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => stopping ??= (async () => {
    await server.stop();
    await disconnect();
  })();
}

function isFrameworkAssetUpload(request: Request): boolean {
  if (request.method !== "PUT") return false;
  const match = new URL(request.url).pathname.match(/^\/api\/internal\/framework-results\/([^/]+)\/assets\/([^/]+)$/);
  if (!match) return false;
  try {return frameworkIdentitySchema.safeParse(decodeURIComponent(match[1]!)).success
    && frameworkAssetIdSchema.safeParse(decodeURIComponent(match[2]!)).success;}
  catch {return false;}
}

export function serveCore(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  return Bun.serve({port, idleTimeout: CORE_HTTP_IDLE_TIMEOUT_SECONDS, maxRequestBodySize: CORE_REQUEST_BODY_BYTES, async fetch(request) {
    if (!request.body || isFrameworkAssetUpload(request)) return fetch(request);
    const bundleUpload = request.method === 'POST' &&
      /^\/api\/internal\/routine-definitions\/bundles\/[a-f0-9]{64}$/.test(new URL(request.url).pathname);
    // Authenticate bundle streams in Hono before their service performs bounded receipt/hash buffering.
    if (bundleUpload) {
      const response = await fetch(request);
      // Bun 1.3.14 needs rejected bodies framed before reusing their connection.
      // Discard without buffering, bounded by the listener's native byte ceiling
      // and a deadline; authentication has already run before this work begins.
      if (response.status >= 400 && !request.bodyUsed) {
        const reader = request.body.getReader();
        let discarded = 0;
        const deadline = setTimeout(() => {void reader.cancel().catch(() => undefined);}, 10_000);
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            discarded += chunk.value.byteLength;
            if (discarded > CORE_REQUEST_BODY_BYTES) {
              await reader.cancel();
              break;
            }
          }
        } finally {clearTimeout(deadline); reader.releaseLock();}
        const headers = new Headers(response.headers);
        headers.set("Connection", "close");
        return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
      }
      return response;
    }
    const limit = CORE_ORDINARY_BODY_BYTES;
    const length = request.headers.get("content-length");
    if (length && !request.headers.has("transfer-encoding")) {
      if (Number(length) > limit) {
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
        if (size > limit) {
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
