import type {BrowserContext, Page} from "playwright-core"
import type {TeamsDevices} from "./teams-devices"

/** Observe actual connections without changing devices, constraints, SDP or media. */
export async function installMediaDiagnostics(context: BrowserContext) {
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = []
    const captures: MediaStreamTrack[] = []
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia = new Proxy(navigator.mediaDevices.getUserMedia, {
        apply(target, thisArg, args) {
          const pending = Reflect.apply(target, thisArg, args) as Promise<MediaStream>
          void pending.then(
            (stream) => {
              captures.push(...stream.getTracks())
            },
            () => {},
          )
          return pending
        },
      })
    }
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
    Object.defineProperty(window, "__mentraCaptureDiagnostics", {value: () => captures.map(track)})
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
          captures: await frame.evaluate(() => (window as any).__mentraCaptureDiagnostics?.() ?? null),
        }
      } catch (error) {
        return {index, error: String(error)}
      }
    }),
  )
}

export function hasAdvancingLaptopMedia(
  before: Awaited<ReturnType<typeof sampleMediaDiagnostics>>,
  after: Awaited<ReturnType<typeof sampleMediaDiagnostics>>,
  devices: TeamsDevices,
) {
  const captures = after.flatMap((frame) => frame.captures ?? [])
  if (
    ![devices.microphone, devices.camera].every((label) =>
      captures.some((t: any) => t.label === label && t.readyState === "live" && t.enabled && !t.muted),
    )
  )
    return false
  const advanced = (kind: string, counter: string) =>
    after.some((frame) =>
      frame.peers?.some(
        (peer: any) =>
          peer.connectionState === "connected" &&
          peer.stats.some((row: any) => {
            if (row.type !== "outbound-rtp" || row.kind !== kind || !(row[counter] > 0)) return false
            const prior = before
              .find((f) => f.index === frame.index)
              ?.peers?.find((p: any) => p.index === peer.index)
              ?.stats.find((s: any) => s.id === row.id)
            return row[counter] > (prior?.[counter] ?? 0)
          }),
      ),
    )
  return advanced("audio", "packetsSent") && advanced("video", "framesEncoded") && advanced("video", "bytesSent")
}
