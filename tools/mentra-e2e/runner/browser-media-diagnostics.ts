import type {BrowserContext, Page} from "playwright-core"

/** Observe actual connections without changing devices, constraints, SDP or media. */
export async function installMediaDiagnostics(context: BrowserContext) {
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = []
    const NativePeer = window.RTCPeerConnection
    if (!NativePeer) return
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection
        peers.push(peer)
        return peer
      },
    })
    const track = (t: MediaStreamTrack | null) =>
      t && {kind: t.kind, label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState}
    // Allowlisted counters only: no SDP, IP addresses, ICE credentials or raw media.
    const keys = [
      "id",
      "type",
      "timestamp",
      "kind",
      "mediaType",
      "codecId",
      "mimeType",
      "transportId",
      "packetsReceived",
      "packetsSent",
      "packetsLost",
      "bytesReceived",
      "bytesSent",
      "framesReceived",
      "framesDecoded",
      "framesDropped",
      "framesEncoded",
      "framesSent",
      "frameWidth",
      "frameHeight",
      "framesPerSecond",
      "keyFramesDecoded",
      "keyFramesEncoded",
      "totalAudioEnergy",
      "totalSamplesDuration",
      "totalSamplesReceived",
      "audioLevel",
      "jitter",
      "roundTripTime",
      "currentRoundTripTime",
      "qualityLimitationReason",
      "dtlsState",
      "iceState",
      "availableOutgoingBitrate",
      "availableIncomingBitrate",
    ]
    const types = new Set([
      "inbound-rtp",
      "outbound-rtp",
      "remote-inbound-rtp",
      "remote-outbound-rtp",
      "codec",
      "transport",
    ])
    Object.defineProperty(window, "__mentraMediaDiagnostics", {
      value: async () =>
        Promise.all(
          peers.map(async (peer, index) => {
            const stats: Record<string, unknown>[] = []
            let error: string | undefined
            try {
              const report = await peer.getStats()
              report.forEach((row) => {
                if (types.has(row.type))
                  stats.push(Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]])))
              })
            } catch (e) {
              error = String(e)
            }
            return {
              index,
              connectionState: peer.connectionState,
              iceConnectionState: peer.iceConnectionState,
              signalingState: peer.signalingState,
              senders: peer.getSenders().map((s) => track(s.track)),
              receivers: peer.getReceivers().map((r) => track(r.track)),
              stats,
              error,
            }
          }),
        ),
    })
  })
}

export async function sampleMediaDiagnostics(page: Page) {
  return Promise.all(
    page.frames().map(async (frame, index) => {
      try {
        return {
          index,
          peers: await frame.evaluate(async () => {
            const sample = (window as any).__mentraMediaDiagnostics
            return sample ? sample() : null
          }),
        }
      } catch (error) {
        return {index, error: String(error)}
      }
    }),
  )
}
