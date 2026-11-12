# `session.stream`

Live video streaming from the glasses camera. One entry point,
`session.stream.startStream()`, covers both ways to stream: a Mentra-hosted
(managed) stream that returns playback URLs, or a direct publish to an ingest
URL you own. `onStatus()` reports what happens to the stream after it starts.

The Mentra App owns the stream lifecycle (`PhoneStreamCoordinator`); this
module is a thin pass-through over the bridge.

Source: [mobile/modules/miniapp/src/modules/stream.ts](../../mobile/modules/miniapp/src/modules/stream.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Managed (default): Mentra hosts the stream.
const stream = await session.stream.startStream({ingest: "whip"})
console.log(stream.webrtcUrl) // WHEP playback

const unsubscribe = session.stream.onStatus((status) => {
  console.log(status.source, status.status, status.reason)
})

// Direct: publish straight to your own ingest URL.
// await session.stream.startStream({direct: "rtmp://ingest.example.com/live/KEY"})

// later
unsubscribe()
await session.stream.stop(stream.streamId)
```

---

## API

### `startStream(options?)` — `Promise<StreamResult>`

Starts a stream. Without `direct`, Mentra provisions a hosted stream and the
result carries playback URLs. With `direct`, the glasses publish to that URL
and no playback URLs come back.

```ts
interface StartStreamOptions {
  /** Your own ingest URL (rtmp/rtmps/srt/whip). Omit for a managed stream. */
  direct?: string
  /** Managed only: restream targets, bare URLs or {url, name?}. */
  destinations?: Array<string | {url: string; name?: string}>
  /** Managed only: "srt" (default), "whip" or "rtmp". See below. */
  ingest?: "srt" | "whip" | "rtmp"
  video?: {width?: number; height?: number; bitrate?: number; minBitrateBps?: number; initialBitrateBps?: number; fps?: number}
  audio?: {bitrate?: number; sampleRate?: number; echoCancellation?: boolean; noiseSuppression?: boolean}
  /** Glasses start/stop sounds. Defaults to true. */
  sound?: boolean
  /** Direct WHIP only: Bearer token for an authenticated endpoint. */
  authToken?: string
  /** false skips glasses mic capture for the stream. Defaults to true. */
  captureAudio?: boolean
}
```

| `ingest` | Latency | Playback | Path |
| --- | --- | --- | --- |
| `"srt"` (default) | ~10-20s | `hlsUrl` / `dashUrl`, recorded | Glasses publish over their own Wi-Fi. |
| `"rtmp"` | ~10-20s | `hlsUrl` / `dashUrl` | Glasses publish over their own Wi-Fi, TCP 443. For networks that block UDP. |
| `"whip"` | <1s | `webrtcUrl` (WHEP) only, not recorded | **Through the phone**, see below. |

#### WHIP goes through the phone

With `ingest: "whip"`, the glasses start a hotspot, the phone joins it, and
the phone relays the stream to Mentra over its cellular connection. The phone
needs cellular data (or Ethernet), should stay near the glasses, and the
Mentra App must keep running. If the phone leaves the glasses' hotspot, the
relay reports `reconnecting`, rebuilds the hotspot and the uplink, and reports
`reconnected`; it gives up with `error` when three retries in a row fail.
While the hotspot is rebuilt, the glasses' Wi-Fi status can read as
disconnected. That is a consequence of the drop, not its cause.

For long sessions that don't need sub-second latency, prefer `"srt"` or
`"rtmp"`.

**Returns:** `StreamResult`

```ts
interface StreamResult {
  streamId: string
  status: string
  resolvedConfig?: StreamResolvedConfig
  /** Managed only. */
  liveInputId?: string
  mode?: "hls" | "webrtc"
  hlsUrl?: string
  dashUrl?: string
  /** WHEP playback; serves video in "webrtc" mode only. */
  webrtcUrl?: string
}
```

---

### `onStatus(handler)` — `UnsubscribeFn`

Calls `handler` with every status update for the stream this miniapp started
or joined. Needs no manifest permission.

```ts
interface StreamStatus {
  streamId: string
  status: string
  source?: "glasses" | "cloudflare" | "coordinator"
  kind?: string
  reason?: string
  errorDetails?: string
  terminal?: boolean
  willRetry?: boolean
  attempt?: number
  maxAttempts?: number
  transport?: string
  resolvedConfig?: StreamResolvedConfig
  stats?: StreamLiveStats
}
```

| `source` | Statuses | Meaning |
| --- | --- | --- |
| `"glasses"` | `streaming`, `reconnecting`, `reconnected`, `error`, `stopped`, … | The glasses publisher. Reconnects carry `attempt` / `maxAttempts`; `terminal: true` means it gave up. In WHIP mode these come from the current relay attempt only; an attempt that ends is reported by the relay instead. |
| `"coordinator"` | `connected`, `reconnecting`, `reconnected` | The WHIP phone relay (`transport: "softap_relay"`). |
| `"coordinator"` | `suspended`, `resumed` | Bluetooth to the glasses dropped and came back. The stream ends if it stays down for 15 seconds. |
| `"coordinator"` | `hls_ready`, `webrtc_ready` | Playback is live. |
| `"coordinator"` | `error` | The stream has ended. `reason` says why. Call `startStream()` again. |
| `"cloudflare"` | `connected`, `disconnected` | Whether the hosted ingest receives video, polled every 5s. Managed only. |

A stream that recovers by itself keeps its `streamId` and playback URLs. A new
`startStream()` after an `error` returns new ones.

`stats` (encoder bitrate, fps, temperature) is currently not forwarded: the
Mentra App keeps that telemetry off.

---

### `stop(streamId?)` — `Promise<void>`

Stops the stream with that `streamId`, or this miniapp's active stream when
omitted.

---

### `preview(options?)` — `Promise<PreviewHandle>`

Takes the preview lease that lets a `<StreamPreview>` in the UI show a call's
video. See the JSDoc in the source for details.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `INTERNAL` | any method (rejected Promise) | Phone-side path threw. Check `message`. |
| `PreviewError` codes | `preview` | See `PREVIEW_ERROR_CODES`. |

---

## Wire-level reference

| Method | Request type | Response |
| --- | --- | --- |
| `startStream()` managed | `MANAGED_STREAM_START` | `REQUEST_RESULT` with `data: StreamResult` |
| `startStream({direct})` | `STREAM_START` | `REQUEST_RESULT` with `data: StreamResult` |
| `stop` | `STREAM_STOP` (`{streamId?}`) | `REQUEST_RESULT` |

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onStatus` | `STREAM_STATUS` (`stream_status`) | `StreamStatus` |

---

## Tests

[stream.test.ts](../../mobile/modules/miniapp/src/modules/stream.test.ts),
and the coordinator's status routing in
[PhoneStreamCoordinator.test.ts](../../mobile/modules/engine/src/services/__tests__/PhoneStreamCoordinator.test.ts).
