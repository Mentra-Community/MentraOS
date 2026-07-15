/**
 * Managed-stream provisioning over the cloud-v2 runtime (cloud-client REST):
 *
 *   POST   /api/camera/stream      -> provision (Cloudflare live input)
 *   GET    /api/camera/stream/:id  -> provider's ingest status
 *   DELETE /api/camera/stream/:id  -> teardown
 *
 * Drop-in replacement for the legacy `v2StreamApi` (which hit the v1 cloud's
 * /api/v2/client/streams/managed on backend_url): same exported shapes, so
 * PhoneStreamCoordinator is unchanged apart from the import. Local miniapps
 * use ONLY this path — no legacy V1 transport.
 *
 * Errors are tagged with stage "provision"/"status"/"teardown" and transport
 * "cloud-rest" so a miniapp sees exactly where and on which leg it broke.
 */

import {cloudClientService as cloudClient} from "./CloudClientService"

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
}

export interface CloudflareStatus {
  isConnected: boolean
  state?: string | null
  connectedAt?: string
  lastSeenAt?: string
  reason?: string
}

export type StreamApiStage = "provision" | "status" | "teardown"

export class StreamApiError extends Error {
  readonly transport = "cloud-rest" as const
  constructor(
    public readonly code: string,
    message: string,
    public readonly stage: StreamApiStage,
  ) {
    super(message)
    this.name = "StreamApiError"
  }
}

/** The cloud-v2 runtime's ManagedStream wire shape (open records, see protocol). */
interface ManagedStreamWire {
  streamId: string
  ingest: {
    url?: string
    streamKey?: string
    rtmpUrl?: string
    srtUrl?: string
    webrtcPublishUrl?: string
  }
  playback: {
    hls?: string
    dash?: string
    webrtc?: string
  }
}

/**
 * Provision a managed stream on the cloud-v2 runtime. Returns ready-to-publish
 * ingest URLs (credentials embedded) plus the playback URLs.
 */
export async function provisionManagedStream(
  restreamDestinations?: RestreamDestinationInput[],
): Promise<ProvisionResult> {
  let wire: ManagedStreamWire
  try {
    wire = (await cloudClient.startManagedStream(
      restreamDestinations && restreamDestinations.length > 0 ? {restreamDestinations} : {},
    )) as ManagedStreamWire
  } catch (err) {
    throw new StreamApiError(
      "STREAM_PROVISION_FAILED",
      err instanceof Error ? err.message : String(err),
      "provision",
    )
  }

  const ingest = wire.ingest ?? {}
  const playback = wire.playback ?? {}
  const rtmpUrl = ingest.rtmpUrl ?? (ingest.url && ingest.streamKey ? `${ingest.url}${ingest.streamKey}` : "")
  if (!playback.hls || !playback.dash) {
    throw new StreamApiError(
      "STREAM_PROVISION_INCOMPLETE",
      `runtime returned no playback URLs for stream ${wire.streamId}`,
      "provision",
    )
  }

  return {
    liveInputId: wire.streamId,
    rtmpUrl,
    srtUrl: ingest.srtUrl,
    hlsUrl: playback.hls,
    dashUrl: playback.dash,
    webrtcUrl: playback.webrtc,
    webrtcPublishUrl: ingest.webrtcPublishUrl,
  }
}

/** The provider's view of the ingest: is the device's push arriving? */
export async function getManagedStreamStatus(liveInputId: string): Promise<CloudflareStatus> {
  try {
    const s = await cloudClient.getManagedStreamStatus(liveInputId)
    return {
      isConnected: s.isConnected,
      state: s.state,
      connectedAt: s.connectedAt,
      lastSeenAt: s.lastSeenAt,
      reason: s.reason,
    }
  } catch (err) {
    throw new StreamApiError(
      "STREAM_STATUS_FAILED",
      err instanceof Error ? err.message : String(err),
      "status",
    )
  }
}

/** Tear down the provider stream. */
export async function teardownManagedStream(liveInputId: string): Promise<void> {
  try {
    await cloudClient.stopManagedStream(liveInputId)
  } catch (err) {
    throw new StreamApiError(
      "STREAM_TEARDOWN_FAILED",
      err instanceof Error ? err.message : String(err),
      "teardown",
    )
  }
}
