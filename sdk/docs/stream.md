# `session.stream`

Video streaming from the glasses camera. The miniapp calls
`session.stream.startUnmanaged({...})` to push frames to a developer-owned RTMP
endpoint, or `session.stream.startManaged({...})` to let the cloud host the
stream and hand back HLS / DASH / WebRTC URLs.

The phone-side daemon (LocalMiniappRuntime → cloud streaming extensions) owns
the stream lifecycle. The SDK module is a thin pass-through over the bridge.

> **Status:** Deferred in v1 — methods bridge to the runtime but the
> daemon path isn't live yet. Calls return shape-correct placeholders
> until then.

Source: [mobile/modules/miniapp/src/modules/stream.ts](../../mobile/modules/miniapp/src/modules/stream.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Unmanaged: push to your own RTMP server.
const streamId = await session.stream.startUnmanaged({
  streamUrl: "rtmp://ingest.example.com/live/abc123",
  video: true,
  audio: true,
})

// …or managed: let the cloud host it.
const managed = await session.stream.startManaged({
  restreamDestinations: ["rtmp://twitch/..."],
})
console.log(managed.hlsUrl, managed.dashUrl, managed.webrtcUrl)

// later
await session.stream.stop(streamId)
```

---

## API

### `startUnmanaged(options)` — `Promise<string>`

Starts an **unmanaged** stream: the glasses encode and push directly to a
developer-supplied URL (typically RTMP). Returns the runtime-assigned
`streamId` — pass it to `stop()` to tear down.

**Parameters:** `StartUnmanagedOptions`

```ts
interface StartUnmanagedOptions {
  /** Destination URL (e.g. rtmp://...). */
  streamUrl: string
  /** Include video. Defaults to `true`. */
  video?: boolean
  /** Include audio. Defaults to `true`. */
  audio?: boolean
}
```

**Returns:** `string` — the assigned `streamId`, or `""` if the runtime
returned no result.

---

### `startManaged(options?)` — `Promise<ManagedStreamResult>`

Starts a **managed** stream: the cloud hosts the stream and exposes
playback URLs (HLS / DASH / WebRTC). Optionally fans out to one or more
restream destinations.

**Parameters:** `StartManagedOptions`

```ts
interface StartManagedOptions {
  /** Optional list of restream destinations (e.g. RTMP URLs). */
  restreamDestinations?: string[]
}
```

**Returns:** `ManagedStreamResult`

```ts
interface ManagedStreamResult {
  /** Runtime-assigned stream identifier. */
  streamId: string
  /** Cloud-hosted HLS playback URL, when available. */
  hlsUrl?: string
  /** Cloud-hosted DASH playback URL, when available. */
  dashUrl?: string
  /** Cloud-hosted WebRTC playback URL, when available. */
  webrtcUrl?: string
}
```

When the runtime returns no result, the module falls back to
`{streamId: ""}`.

---

### `stop(streamId?)` — `Promise<void>`

Stops a stream. Pass the `streamId` returned by `startUnmanaged` /
`startManaged` to target a specific stream; omit to let the runtime stop
whatever this miniapp has active.

---

## Types

```ts
interface StreamStatus {
  streamId: string
  status: string
  errorDetails?: string
}
```

Exported for consumers wiring `STREAM_STATUS` stream events; the module
itself does not subscribe.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `NOT_IMPLEMENTED` | `startUnmanaged`, `startManaged`, `stop` (rejected Promise) | Runtime hasn't wired up streaming on this build. |
| `INTERNAL` | any method (rejected Promise) | Phone-side path threw. Check `message`. |

This module declares no synchronous throws and does not gate on a manifest
permission at the SDK layer — permission enforcement, if any, happens
phone-side.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `startUnmanaged` | `STREAM_START` (`{streamUrl, video, audio}`) | `REQUEST_RESULT` with `data: {streamId}` |
| `startManaged` | `MANAGED_STREAM_START` (`{restreamDestinations}`) | `REQUEST_RESULT` with `data: ManagedStreamResult` |
| `stop` | `STREAM_STOP` (`{streamId?}`) | `REQUEST_RESULT` |

Streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| — (no module hook yet) | `STREAM_STATUS` | `StreamStatus` |

`MANAGED_STREAM_STOP` is reserved in the wire protocol but not used by this
module — `stop()` always emits `STREAM_STOP`.

---

## Tests

_no integration tests yet_
