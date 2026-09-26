# Frame preview

Native transport behind `<StreamPreview>`: forks decoded call video out of the existing ACS
pipeline and pushes it into the miniapp's WebView as raw binary YUV, sized to the view and paced
by the page. There is no second encoder, no extra WebRTC connection and no native overlay, and
frame bytes never touch React Native JavaScript, JSON or base64.

The rule this module is built around: **the preview must cost the call nothing**. A slow page
lowers the preview's frame rate; a preview bug stops the preview. Neither reaches the ACS sender.

## Shape

```text
existing decoder
  ├── existing ACS sender → Teams          (unchanged; counted as acsSendFps)
  └── DecodedFrameTap (optional)
        → CallSource (PreviewSourcePort: attach → generation, generation-checked detach)
        → admission: one credit, absolute fps schedule, one queued frame
        → single pack worker: validate geometry → downscale into a preallocated slot → header
        → binary transport
        → WebGL renderer in the miniapp page
        → ack (gen, seq) → credit returns
```

| Platform | Transport | Downscale |
|---|---|---|
| Android | `WebViewCompat.addWebMessageListener` + `JavaScriptReplyProxy.postMessage(byte[])`. Requires `WEB_MESSAGE_LISTENER` and `WEB_MESSAGE_ARRAY_BUFFER`, otherwise `bind` reports `webview_feature_missing`. | libyuv box scale via WebRTC's `JavaI420Buffer` (area-average Kotlin fallback if the native library is unavailable). |
| iOS | Loopback WebSocket (`NWListener`) bound to `127.0.0.1` on an ephemeral port, per-document token. | vImage (`vImageScale_Planar8` / `vImageScale_CbCr8`). |

## JS API

`@mentra/frame-preview` exports `FramePreviewModule` (native name `MentraFramePreview`):

| Call | Notes |
|---|---|
| `bind({hostViewTag, packageName, traceId})` | Android installs the listener; the host calls it before the first navigation. Returns `{installReloadRequired, unavailableReason?}`. |
| `prepareDocument({docGen, traceId})` | New token per document, idempotent per `docGen`. Returns `{protocolVersion: 1, transport, url?, portName?, token, docGen}`. Rejects `not_bound`. |
| `configure({source, mode, targetWidth, targetHeight, maxFps, diagnostics?})` | Rejects `diagnostics_disabled` when needed. A tier change never restarts production or the transport. |
| `start()` / `stop(reason)` | `stop` keeps the authenticated transport. |
| `unbind(reason)` | Destroys the transport. |
| `setDiagnosticsEnabled`, `setTapTelemetry`, `setRunLogEnabled` | See below. |
| `injectFault({kind, ms?})` | Diagnostics only: `ack_delay`, `ack_drop`, `transport_close`, `pack_throw`, `sink_throw`, `clear`. |
| `resetStats()`, `runLogPath()` | |

Events: `onStatus` (1 Hz), `onStopped({reason, docGen})` with `ack_timeout`, `pack_failed`,
`transport_failed`, `source_detached`, `diagnostics_disabled` or the caller's reason, and `onLog`
(`PREVIEW_TRACE` lines for the host to forward to the console).

## Lifetimes

- **Binding** belongs to a native WebView. An Android listener registered after a document loaded
  does not exist in that document; `installReloadRequired` is the fallback and is counted as
  `installReloads`, which should stay 0 because the host binds before navigating.
- **Document** belongs to one page load: a new token, the old consumer dropped, credit revoked.
- **Production** is `start`/`stop`. Stopping keeps the transport, so restarting needs no handshake.

## Failure isolation

- Declared errors (Kotlin `Throwable`, Swift `throws`) from the tap sink are caught in
  `DecodedFrameTap`; those from the pack worker are caught in the worker. Both are counted
  (`tapSinkExceptions`, `packFailures`) and stop the subscription with `pack_failed`.
- Swift runtime traps cannot be caught, so they are prevented: geometry is validated before any
  copy (non-zero size, stride at least the row, every plane inside its buffer, payload equal to
  the header length), frames are packed only into preallocated slots, and the tap, pacer and pack
  code avoid force-unwraps (`ios/.swiftlint.yml`).
- Slots are sized to one produced frame and replaced only when that size changes (tier change or
  source resolution change), never per frame and never while a worker or the transport holds one.

## Sizing

The host sends a target box already quantized to a tier (`320x180`, `640x360`). Native fits the
source inside it with the source's aspect ratio, rounds to even sizes, never upscales, and the
header and `outWidth`/`outHeight` report what was produced. Native also enforces a ceiling:
640x360 at 15 fps normally, 1920x1080 at 30 fps with diagnostics on.

## Diagnostics, telemetry and logs

| Setting | Debug default | Release default | Controls |
|---|---|---|---|
| Diagnostics | on | off | synthetic source, non-`render` modes, `noiseAmplitude`, `consumerDelayMs`, fault hooks, the higher ceiling |
| Run log | on | off | NDJSON file and the 1 Hz `PREVIEW_TRACE phase=status` line |
| Tap telemetry | off | off | tap cadence, offer cost and `acsSendFps` with no preview attached |

With tap telemetry off and no preview attached, `DecodedFrameTap.offer` returns after one state
read. With it on, a stopped preview records a `runKind: "telemetry"` NDJSON run, which is the
preview-off baseline for the same counters.

Lifecycle lines use the `PREVIEW_TRACE` marker and `phase=` key-values with `previewTraceId`,
`docGen`, `gen` and a monotonic `t`. Tokens and meeting URLs are redacted and URL query strings
stripped. Nothing is logged per frame; repeated warnings log once and then a count every 10 s.

Run logs: Android `<external files>/frame-preview/<runId>.ndjson` (`adb pull`), iOS
`Application Support/frame-preview/<runId>.ndjson`. Lines are `meta`, `status`, `event` and
`end`; `end` repeats the contract counters. [`tools/`](tools/RUNBOOK.md) holds the script that
summarises a run and checks two runs against the screening and release-gate limits.

## Frame protocol

64-byte little-endian header, then tightly packed 8-bit YUV.

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

Payload size for both formats is `width*height + 2*ceil(width/2)*ceil(height/2)`. I420 is
`Y | U | V`; NV12 is `Y | UVUV…`. Native timestamps are only compared with other native
timestamps.

### Golden fixtures

`fixtures/` holds MFPV frames and `manifest.json`, generated by `fixtures/generate.mjs`: valid
I420 and NV12 at odd and even sizes, every rotation, colour matrix and range, the fallback flag,
and one malformed file per parser reason (`short-buffer`, `bad-magic`, `unsupported-version`,
`bad-header-length`, `bad-dimensions`, `unknown-pixel-format`, `payload-size-mismatch`,
`truncated-payload`). Kotlin, Swift and TypeScript assert the same files.

```sh
node mobile/modules/frame-preview/fixtures/generate.mjs --check
```

## Backpressure

One credit. A frame is admitted only when production is running, a consumer has authenticated
for the current document, nothing is in flight, and the schedule says the slot is due. The
schedule is absolute (`nextDue += period`), so a slow consumer lowers delivered fps and never
builds a queue. An unacknowledged frame past 2 s stops the subscription with `ack_timeout`; it
never mints a replacement credit.

## Diagnostic modes

| Mode | Runs | Isolates |
|---|---|---|
| `off` | nothing | — |
| `generate_only` | source frame only | cost of producing a picture |
| `pack_only` | + validate, downscale, pack | the copy |
| `receive_discard` | + transport, page validates | transport and parse |
| `render` | + page draws | upload, shader, draw submit |

## Verification

```sh
swift test --package-path mobile/modules/frame-preview/ios/PreviewKit
cd mobile/android && ./gradlew :mentra-frame-preview:testDebugUnitTest
cd mobile/android && ./gradlew :mentra-frame-preview:connectedDebugAndroidTest   # device or emulator
swift test --package-path mobile/modules/glasses-media/ios/CoreKit                # macOS
```

JVM and SwiftPM suites cover the golden fixtures, the pacer, geometry validation, downscale
sizing, the slot pool, diagnostics gating, tap telemetry, the trace format and redaction, and
the full pipeline with a fake transport: sink and worker throws, malformed geometry, ack drop,
ack delay, transport close and tier changes. The instrumented Android test runs a real WebView
with the listener installed before navigation and checks a binary frame and its ack round-trip
with `installReloads == 0`. `LoopbackFrameSocketTests` (macOS) connects a real
`URLSessionWebSocketTask`, checks token auth, rejects a wrong token, and asserts the listener is
reachable on 127.0.0.1 only. The vImage path and the loopback socket compile only on Apple
platforms.

### CI and manual pre-merge checks

Pull requests run the JVM suite (`Mobile App Android Unit Tests`), the SwiftPM suite on macOS
(`Glasses Media Swift Tests`), and the fixture check, the host coordinator tests, the SDK tests
and the gate tool tests (`Mobile App Quality Checks`). No PR workflow boots an Android emulator
or an iOS simulator, so before merging a change to the native module or its transport, run
these by hand and paste the result into the PR:

- **Android WebView round trip:** `connectedDebugAndroidTest` (above) on an emulator or device
  with a current Android System WebView.
- **iOS in the app:** `FramePreviewModule.swift`, `FramePreviewSession.swift` and the tap hook
  in `AcsMeetingModule.swift` sit outside the SwiftPM packages and have no XCTest target (the
  tap's core logic is covered by glasses-media `CoreKit`). Build the app for a device and run a
  call with the preview shown, hidden and reloaded, then check the `PREVIEW_TRACE` lines and
  the NDJSON `end` counters.
