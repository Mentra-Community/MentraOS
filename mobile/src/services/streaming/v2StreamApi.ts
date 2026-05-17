/**
 * Fetch client for /api/v2/client/streams/managed.
 * Mirror of cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts.
 */

import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "@mentra/island"

/**
 * Restream destination. The full stream key is part of the URL — Cloudflare
 * appends nothing on the publish side. `name` is a human label that surfaces
 * in Cloudflare's dashboard but doesn't affect routing.
 */
export interface RestreamDestination {
  url: string
  name?: string
}

/** Caller-facing shape: either a bare URL string or the full object. */
export type RestreamDestinationInput = string | RestreamDestination

export interface ProvisionResult {
  liveInputId: string
  rtmpUrl: string
  srtUrl?: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
  webrtcPublishUrl?: string
  outputs?: Array<{id: string; url: string; status?: string}>
}

export interface CloudflareStatus {
  isConnected: boolean
  connectedAt?: string
  disconnectedAt?: string
  viewerCount?: number
}

class StreamConfigError extends Error {
  code = "STREAM_CONFIG_MISSING"
  constructor(message: string) {
    super(message)
    this.name = "StreamConfigError"
  }
}

function baseUrl(): string {
  const url = getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.backendUrl)
  if (!url) {
    throw new StreamConfigError(
      "Managed streaming needs the host's backend_url; this phone hasn't been signed in / configured yet.",
    )
  }
  return url.replace(/\/$/, "")
}

function authHeader(): Record<string, string> {
  const token = getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.coreToken)
  if (!token) {
    throw new StreamConfigError(
      "Managed streaming needs the host's core_token; user is not authenticated.",
    )
  }
  return {authorization: `Bearer ${token}`, "content-type": "application/json"}
}

export async function provisionManagedStream(
  restreamDestinations?: RestreamDestinationInput[],
): Promise<ProvisionResult> {
  const res = await fetch(`${baseUrl()}/api/v2/client/streams/managed/provision`, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify(restreamDestinations ? {restreamDestinations} : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`provisionManagedStream HTTP ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as ProvisionResult
}

export async function getManagedStreamStatus(liveInputId: string): Promise<CloudflareStatus> {
  const res = await fetch(
    `${baseUrl()}/api/v2/client/streams/managed/${encodeURIComponent(liveInputId)}/status`,
    {headers: authHeader()},
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`getManagedStreamStatus HTTP ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as CloudflareStatus
}

export async function teardownManagedStream(liveInputId: string): Promise<void> {
  const res = await fetch(
    `${baseUrl()}/api/v2/client/streams/managed/${encodeURIComponent(liveInputId)}`,
    {method: "DELETE", headers: authHeader()},
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`teardownManagedStream HTTP ${res.status}: ${text || res.statusText}`)
  }
}
