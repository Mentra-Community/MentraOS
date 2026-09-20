# Frame preview (experiment)

Forks decoded video out of the existing call pipeline and pushes it into the Mentra Call
miniapp's WebView as raw binary, so we can answer one question with measurements instead of
opinion: **can the miniapp WebView receive and render 1280×720 YUV at up to 15 fps without
hurting the call?**

This is an experiment, not a product path. There is no second encoder, no extra WebRTC
connection, no native overlay, and no public SDK surface.

## Shape

```text
existing decoder
  ├── existing ACS sender → Teams          (unchanged)
  └── DecodedFrameTap (optional)
        → admission: one credit, absolute fps schedule, one free slot
        → single pack worker (tight YUV, stride-aware)
        → binary transport
        → WebGL renderer in the miniapp page
        → ack (gen, seq) → credit returns
```

Control and status travel as JSON on the WebView bridge the miniapp already has. Frame bytes
never touch React Native JavaScript, the miniapp's background JSContext, JSON, or base64.

## Transports

| Platform | Mechanism | Why |
|---|---|---|
| Android | `WebViewCompat.addWebMessageListener` + `JavaScriptReplyProxy.postMessage(byte[])` | Chromium hands the page an `ArrayBuffer` directly. Requires `WEB_MESSAGE_LISTENER` and `WEB_MESSAGE_ARRAY_BUFFER`; the experiment reports itself unavailable otherwise. |
| iOS | Loopback WebSocket (`NWListener` + `NWProtocolWebSocket`) on `127.0.0.1` | WKWebView has no native → page binary channel. The socket is bound to loopback with an ephemeral port and a per-document token. |

Two lifetimes are kept apart, and conflating them is the bug this design exists to avoid:

- **Binding** belongs to a native WebView. An Android message listener cannot be added to a
  document that has already loaded, so the first bind may need exactly one reload. Re-binding
  the same view never asks for another.
- **Document** belongs to one page load. A new document mints a new token, drops the old reply
  proxy or connection, and revokes credit. It is bumped where the host already resets its ready
  handshake — launch, reload, hot reload, content-process termination — and deliberately **not**
  from `onLoadEnd`, which fires several times per load.

`stop()` halts frame production but keeps the authenticated transport, so `start()` needs no new
handshake. `unbind()` destroys the transport; the page must handshake again.

## Frame protocol

64-byte little-endian header, then tightly packed 8-bit YUV. Golden bytes are asserted in Kotlin,
Swift and TypeScript, so a drift in any one of them fails a named test.

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `MFPV` |
| 4 | 2 | version (1) |
| 6 | 2 | header length (64) |
| 8 | 4 | payload length |
| 12 | 4 | session generation |
| 16 | 4 | frame sequence |
| 20 | 2 | width |
| 22 | 2 | height |
| 24 | 1 | pixel format: 1 = I420, 2 = NV12 |
| 25 | 1 | rotation, quarter turns clockwise |
| 26 | 1 | colour matrix: 0 unknown, 1 BT.601, 2 BT.709 |
| 27 | 1 | colour range: 0 unknown, 1 limited, 2 full |
| 28 | 2 | flags; bit 0 = colour metadata was missing and the fallback was used |
| 30 | 2 | reserved |
| 32 | 8 | source timestamp, native monotonic clock, 0 if unknown |
| 40 | 8 | monotonic clock immediately before the send call |
| 48 | 16 | reserved |

Payload size for both formats is `width*height + 2*ceil(width/2)*ceil(height/2)`; 1280×720 is
1,382,400 bytes, so 15 fps is 20,736,000 bytes per second. I420 is `Y | U | V`; NV12 is
`Y | UVUV…`. A reader validates version, lengths, dimensions and format before touching a pixel.

Native timestamps are only ever compared with other native timestamps. The page measures its own
work with `performance.now()` and the two are never subtracted from each other.

## Backpressure

One credit. A frame is admitted only when production is running, a consumer has authenticated
for the current document, nothing is in flight, and the wall clock says the slot is due. The
schedule is absolute (`nextDue += period`), not "wait one period after finishing", which would
add the consumer's latency to every interval. A slow consumer therefore lowers delivered fps and
never builds a queue. An unacknowledged frame past the 2 s deadline stops the subscription; it
never mints a replacement credit.

## Diagnostic modes

| Mode | Runs | Isolates |
|---|---|---|
| `off` | nothing | — |
| `generate_only` | source frame only | cost of producing a 720p picture |
| `pack_only` | + stride-aware pack | the copy |
| `receive_discard` | + transport, page validates | transport and parse |
| `render` | + page draws | upload, shader, draw submit |

`generate_only` is the baseline for synthetic comparisons: without it the difference between
modes would include the cost of inventing the picture. For real-call comparisons the call and
its incoming video are left alone and only the mode changes.

Real frames are reported at whatever the decoder actually produced. Android scales to the
negotiated ACS profile before I420, so a call requesting 540p previews at 540p and says so; it is
never upscaled and relabelled 720p.

## Verification

```sh
swift test --package-path mobile/modules/frame-preview/ios/PreviewKit
cd mobile/android && ./gradlew :mentra-frame-preview:testDebugUnitTest
```

Unit tests cover the header's golden bytes, the pacer (credit, absolute schedule, stall resync,
stale and duplicate acks, timeout, stop/restart), stride-aware packing, the header surviving
`I420Packer.pack`'s `clear()`, and the synthetic lease pool refusing to overwrite a buffer a
worker still holds.

Neither proves the module links into the app. That needs an app build on each platform, and the
transport question itself can only be answered on physical hardware.
