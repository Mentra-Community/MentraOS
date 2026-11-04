/** The largest body Core's handlers receive. */
export const CORE_ORDINARY_BODY_BYTES = 128 * 1024 * 1024;
/** Bun's own ceiling sits above it, so a larger body still gets Core's answer once its framing is read. */
export const CORE_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;
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

export function serveCore(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  return Bun.serve({port, idleTimeout: CORE_HTTP_IDLE_TIMEOUT_SECONDS, maxRequestBodySize: CORE_REQUEST_BODY_BYTES, async fetch(request) {
    if (!request.body) return fetch(request);
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
