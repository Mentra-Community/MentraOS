/** Raw recording uploads share the listener; JSON routes retain their own small limits. */
export const CORE_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024;

export function serveCore(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  return Bun.serve({port, maxRequestBodySize: CORE_REQUEST_BODY_BYTES, fetch});
}
