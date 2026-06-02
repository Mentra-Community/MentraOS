/**
 * Fetch client for /api/v2/client/photo.
 * Mirror of cloud/packages/cloud/src/api/hono/client/v2/photo.api.ts.
 */

import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "@mentra/island"

export interface PhotoResult {
  photoUrl: string
  mimeType: string
  size: number
}

export type PollOutcome =
  | {kind: "ready"; result: PhotoResult}
  | {kind: "error"; code: string; message: string}

class PhotoConfigError extends Error {
  code = "PHOTO_CONFIG_MISSING"
  constructor(message: string) {
    super(message)
    this.name = "PhotoConfigError"
  }
}

function baseUrl(): string {
  const url = getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.backendUrl)
  if (!url) {
    throw new PhotoConfigError(
      "Photo capture needs the host's backend_url; this phone hasn't been signed in / configured yet.",
    )
  }
  return url.replace(/\/$/, "")
}

function authHeader(): Record<string, string> {
  const token = getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.coreToken)
  if (!token) {
    throw new PhotoConfigError(
      "Photo capture needs the host's core_token; user is not authenticated.",
    )
  }
  return {authorization: `Bearer ${token}`, "content-type": "application/json"}
}

export async function requestPhoto(): Promise<{
  requestId: string
  uploadUrl: string
  uploadToken: string
}> {
  const res = await fetch(`${baseUrl()}/api/v2/client/photo/request`, {
    method: "POST",
    headers: authHeader(),
    body: "{}",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`v2 photo /request HTTP ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as {requestId: string; uploadUrl: string; uploadToken: string}
}

/**
 * Long-poll the photo slot. Server hangs up to 30s waiting for /upload to
 * arrive. Optional AbortSignal lets the coordinator cancel client-side.
 */
export async function pollUntilReady(
  requestId: string,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  let res: Response
  try {
    res = await fetch(`${baseUrl()}/api/v2/client/photo/${encodeURIComponent(requestId)}`, {
      headers: authHeader(),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return {kind: "error", code: "aborted", message: "Client aborted"}
    throw err
  }
  if (res.status === 200) {
    const body = (await res.json()) as PhotoResult
    return {kind: "ready", result: body}
  }
  // Both 408 (timeout / client_aborted) and 502 (storage / upload error) bring
  // back a typed {code, message}. Normalize to the same outcome shape.
  const body = (await res.json().catch(() => ({}))) as {code?: string; message?: string}
  return {
    kind: "error",
    code: body.code || `http_${res.status}`,
    message: body.message || res.statusText,
  }
}

export async function freePhoto(requestId: string): Promise<void> {
  // Best-effort cleanup. Swallow ALL failures, including synchronous throws
  // from baseUrl()/authHeader() when the host isn't configured (we're
  // already on an error path; surfacing this would mask the real failure).
  try {
    await fetch(`${baseUrl()}/api/v2/client/photo/${encodeURIComponent(requestId)}`, {
      method: "DELETE",
      headers: authHeader(),
    })
  } catch {
    /* swallow */
  }
}
