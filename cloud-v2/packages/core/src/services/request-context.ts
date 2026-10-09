/**
 * @fileoverview The id of the request being served, for code that has no Hono context.
 *
 * `requestContext` (the `/api/*` middleware that assigns each request its id) runs the rest of the
 * request inside {@link runWithRequestId}, so anything that request calls, however deep, can read
 * the id with {@link currentRequestId}. Workspace audit events use it to record which request
 * caused them. Outside a request (startup jobs, scripts, tests calling services directly) there
 * is none.
 */

import {AsyncLocalStorage} from "node:async_hooks"

const storage = new AsyncLocalStorage<{requestId: string}>()

/** Run `fn` with `requestId` as the current request's id. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({requestId}, fn)
}

/** The id of the request being served, or null outside one. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null
}
