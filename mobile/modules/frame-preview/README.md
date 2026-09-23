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

## Stress defaults

The panel defaults to **1280×720 at 30 fps**, which is double the product target and about
41.5 MB/s of packed YUV through the transport. A run that holds there has headroom; a run that
does not can be walked down through 15, 10 and 5 to find where it breaks.

Two things had to change before that number meant anything. The synthetic pattern was a
per-pixel loop costing ~175 ms a frame in a debug build, which capped the source near 5 fps and
made every reported number really a number about the generator — it is now built two rows at a
time and copied. And the reporter sorted each percentile ring once per percentile, seven rings a
second, on the queue that packs frames; each ring is now sorted once per report.

Both are measurement-correctness fixes rather than optimisations: the first made the pipeline
unmeasurable, the second put the measurement inside the measurement.

## What gets measured, and where it lands

Every run writes one NDJSON file. The same object that goes to the panel at 1 Hz is appended to
that file, so the screen and the file can never disagree about what a second looked like, and
`pack_only` vs `render` becomes a diff rather than an argument. [`tools/`](tools/RUNBOOK.md) holds the
script that summarises a run and checks two runs against the screening and release-gate limits.

| | |
|---|---|
| Android | `<external files>/frame-preview/<runId>.ndjson` — `adb pull`, no root |
| iOS | `Application Support/frame-preview/<runId>.ndjson` — path is `NSLog`ged at `start()` |

`runId` is shown in the panel and is the file name. Lines are `t: "meta"` (device, OS, mode,
target fps — written once), `t: "status"` (one per second), `t: "event"` (document generations,
consumer auth, transport failures, stale acks, ack timeouts, configure) and `t: "end"`. Each
line is flushed as it is written: the tail of a run that ended in a crash or a thermal shutdown
is the part worth having.

Three groups of counters matter for different questions.

**Is anything compressing.** The synthetic pattern carries grain, which cannot change the
bandwidth — raw YUV is the same size whatever it contains — but flat colour bars are enormously
compressible and noise is not. If `sendCompleteMs*` and `deliveredFps` hold with grain on, then
nothing in the path is quietly deflating and the throughput figure is real. That is the only
reason the noise is there.

**Is the source itself the limit.** `generateMs*` is the synthetic generator's own cost and
nothing else's; a real decoder never pays it. If it approaches the frame period, the run is
measuring the test pattern and every other number is downstream of that.

**Is the preview keeping up.** `deliveredFps` against `targetFps`, and the skip reasons that
explain the difference: `skippedPacing` (not due yet), `skippedBusy` (consumer or worker busy),
with `preDispatchDrops` and `slotStarved` as sub-reasons of the latter — they are already
included in `skippedBusy` and must not be added to it. `outstanding` should be 0 or 1 forever.

**Is it smooth.** `deliveryGapMs*` rather than the mean. A steady 14.8 fps and a 14.8 fps made of
alternating 30 ms and 100 ms gaps are the same number above and very different to look at. Every
timing carries `p95` and a `Max` that is not windowed, because the worst frame of the run is the
one that was visible. The page reports the same cadence from its own clock as `arrivalGapMs*`,
and `markerMismatches` compares the pattern drawn into the pixels against the header's sequence —
the only check that can catch a buffer reused while the page was still reading it.

**Did the call suffer.** This is the group the decision actually turns on, and the only one that
describes something other than the preview. `tapOfferMeanUs` / `tapOfferMaxUs` is time spent on
the decoder thread; `tapCadenceMeanMs` / `tapCadenceMaxMs` is the decoder's own rhythm and is
counted whether or not a preview sink is attached, so a run with preview off is a usable
baseline. On Android `mainQueueWaitMs*` shows how long the send sat behind the app's own UI work,
and `tapSinkExceptions` must stay zero.

Send timing is reported differently per platform on purpose. Chromium copies inside
`postMessage`, so Android's `sendCompleteMs*` is the whole send. Network framework's enqueue
returns before the copy happens, so iOS reports `sendEnqueueMs*` and `sendCompleteMs*`
separately; averaging them under one name would make iOS look an order of magnitude faster than
Android for no reason. Keys a platform cannot honestly measure are absent rather than zero.

Native timings only ever come from the native monotonic clock and page timings only from
`performance.now()`; the two are never subtracted. `drawToRafMs` is draw submission to the next
animation frame, which is the closest honest proxy for presentation — it is not a measurement of
what the display actually showed.

## Verification

```sh
swift test --package-path mobile/modules/frame-preview/ios/PreviewKit
cd mobile/android && ./gradlew :mentra-frame-preview:testDebugUnitTest
```

Unit tests cover the header's golden bytes, the pacer (credit, absolute schedule, stall resync,
stale and duplicate acks, timeout, stop/restart), stride-aware packing, the header surviving
`I420Packer.pack`'s `clear()`, the synthetic lease pool refusing to overwrite a buffer a worker
still holds, and the statistics layer: percentile rings that lap without losing their maximum,
delivery-gap cadence, first-frame latencies, a rate window that restarts with each run, and a
run-log encoder that drops a non-finite number rather than the twenty good counters beside it.

Neither proves the module links into the app. That needs an app build on each platform, and the
transport question itself can only be answered on physical hardware.
