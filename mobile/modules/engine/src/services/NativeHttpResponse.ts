const BODY_FORBIDDEN_STATUSES = new Set([204, 205, 304])

/** Fetch forbids a non-null Response body for these HTTP statuses. */
export function nativeHttpResponseBody(status: number, body: string): string | null {
  return BODY_FORBIDDEN_STATUSES.has(status) ? null : body
}
