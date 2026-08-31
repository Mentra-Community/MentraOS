# @mentra/acs-meeting

Phone-native Azure Communication Services client that puts a MentraOS wearer into a
Microsoft Teams meeting as a guest. The glasses provide the camera and the microphone;
the phone does all the WebRTC and ACS work.

The phone is a **relay, not a capture device**. It subscribes to whatever the glasses
already published to Cloudflare, decodes it, and re-publishes it into ACS. No frame
crosses the JavaScript bridge. Production never generates pixels on the phone.

An investigation-only synthetic arm can generate packed I420 locally at a fixed 15 Hz
(`AcsInvestigation.videoArm`). It ships as `WHEP`. Flip it locally, rebuild native, and
do not commit `SYNTHETIC`.

## The pipeline in one picture

```
 glasses ──WHIP──▶ Cloudflare ──WHEP──▶ │ phone (this module)                │ ──▶ ACS ──▶ Teams
                                        │                                    │
   video:  H.264 ─▶ WebRTC decoder ─▶ I420 ─▶ cropAndScale ─▶ pack ─▶ sendRawVideoFrame
   audio:  Opus  ─▶ WebRTC decoder ─▶ PCM16 ─▶ resample 16k ─▶ sendRawAudioBuffer

   return audio: ACS RawIncomingAudioStream ─▶ base64 ─▶ Expo event ─▶ AudioPlaybackService ─▶ A2DP
```

Two things about this are load-bearing and easy to get wrong:

**ACS encodes for us.** `RawOutgoingVideoStream` accepts raw pixels only — `I420`, `NV12`,
`RGBA`, and a few others — never an H.264 bitstream. We cannot forward the Cloudflare
H.264 as-is; it must be decoded and handed over as pixels. ACS then re-encodes to H.264
internally. The decode is unavoidable; the *conversion* is not, which is why we feed I420
(what the WebRTC decoder already produces) rather than converting to RGBA.

**Only the video path is hot.** At 720p15 the video path moves ~1.4 MB per frame, 15 times
a second. Everything in `video/` and `source/` is written to avoid per-pixel work in
Kotlin: scaling is libyuv via `cropAndScale`, packing is a bulk `ByteBuffer` copy, and
plane buffers are pooled rather than allocated.

## Layout

```
android/src/main/java/com/mentra/acsmeeting/
├── AcsMeetingModule.kt      Expo bridge: join/leave/setMuted/getState, onState + onIncomingPcm events
├── AcsMeetingSession.kt     Orchestrator. Owns the ACS Call and wires the four packages together
│
├── source/                  Upstream — getting glasses media into the process
│   ├── MediaListeners.kt        VideoFrameListener, PcmListener, VideoSource
│   ├── GlassesMediaSource.kt    The transport interface + controller. WHEP is one implementation
│   ├── CloudflareWhepSource.kt  The recvonly WHEP subscriber (PeerConnection, sinks, scaling)
│   ├── SyntheticFrameFactory.kt Packed I420 generator (CHEAP / MOTION pan / NOISE)
│   ├── SyntheticI420Source.kt   Fixed-rate GlassesMediaSource wrapping the factory
│   ├── VideoSourceArm.kt        Investigation switch. Ships as WHEP
│   └── TrackRegistry.kt         Deduplicates track attachment
│
├── video/                   Downstream — pixels into ACS
│   ├── AcsFrameSender.kt        Owns the RawOutgoingVideoStream and the send executor
│   ├── I420FormatSpec.kt        The format we advertise, as plain values
│   ├── AcsTimestamp.kt          100-ns ticks for RawVideoFrame. Zero means freeze.
│   ├── I420Packer.kt            Stride-aware planar copy into one tight buffer
│   ├── FrameGeometry.kt         Buffer-vs-display coordinates under rotation
│   └── SendGate.kt              Single-in-flight backpressure
│
├── audio/                   Two microphones, one call
│   ├── AcsAudioPolicy.kt        Pure decision functions: which stream, who gets muted
│   ├── AudioPolicyApplier.kt    Applies a decision to the live call, with retries
│   └── PcmBridge.kt             Resample/rebuffer to ACS's 16 kHz mono 20 ms frames
│
└── telemetry/               The measurement ladder
    ├── PipelineStats.kt         Every counter, and the 1 Hz "P6 ladder" line
    ├── PipelineTicker.kt        Emits that line on a timer
    ├── RingPercentile.kt        p50/p95 over a fixed ring of samples
    └── ChromaProbe.kt           Plane averages, to catch a mis-packed frame
```

Tests mirror this exactly under `android/src/test/java/com/mentra/acsmeeting/`.

The dependency direction is `AcsMeetingSession → {source, video, audio, telemetry}`, with
`source` and `video` both depending on `telemetry` to report, and `telemetry/ChromaProbe`
reaching into `video/I420Packer` for stride math. Nothing in `audio/` touches video.

## Video path

`CloudflareWhepSource` POSTs an SDP offer to the WHEP endpoint, gets an answer, and adds a
`VideoSink` to the remote track. Per frame, on WebRTC's decode thread:

1. If ACS negotiated a different size than the decoder is producing, scale with
   `buffer.cropAndScale(...)` — libyuv, not Kotlin.
2. `toI420()`, then `I420Packer.pack(...)` into one pooled direct buffer, Y then U then V.
3. Hand off to `AcsFrameSender.sendI420`.

`AcsFrameSender` splits that tight buffer back into **three independent direct
`ByteBuffer`s** and submits them on its own `acs-i420-send` thread. This is not an
optimization — ACS's I420 contract requires three separate plane buffers, and passing one
packed buffer throws `CallingCommunicationException` and produces a black tile.

Three constraints worth knowing before changing this code:

- **No inter-frame pacer.** `SendGate` allows exactly one send in flight and nothing else.
  Any minimum-interarrival gate deletes real frames whenever the decoder delivers in
  bursts, which it does.
- **Buffer coordinates, never display coordinates.** `cropAndScale` and `toI420` operate on
  the un-rotated buffer. Mixing in `VideoFrame.rotatedWidth/rotatedHeight` overruns the
  plane whenever rotation is 90° or 270°. `FrameGeometry` exists to keep this honest, and
  the ladder prints `rot=` so a non-zero rotation is visible rather than silently corrupting.
- **A timed-out send does not release its buffers.** `Future.get(timeout)` does not cancel
  the work, so ACS may still be reading those planes. They are deliberately leaked rather
  than recycled, and counted as `abandoned` in the ladder.

## Audio path

Two possible microphones — the glasses or the handset — and the wrong answer means either
silence or the wearer being recorded when they think they are muted. The decision is
therefore a pure function in `AcsAudioPolicy`, unit-tested in isolation, and separate from
the code that applies it.

- **`audioSource: "glasses"`** arms a `RawOutgoingAudioStream` — which ACS reports as
  `VIRTUAL_OUTGOING` — and feeds it WHEP PCM through `PcmBridge`, which downmixes to mono,
  resamples to 16 kHz, and re-chunks into the 20 ms frames ACS expects. The handset mic is
  never opened.
- **`audioSource: "phone"`** uses ACS's own `LocalOutgoingAudioStream` (`LOCAL_OUTGOING`).

`ActiveStreamKind` mirrors that pair, and deliberately reads `NONE` for a stream that is
attached but not `STARTED` — "attached" is not "live", and treating it as live is how a
muted wearer ends up audible.

`AudioPolicyApplier` reports an `AudioSafety` of `safe`, `degraded`, or `unsafe`. `unsafe`
means both mute and stop failed and a live mic may be reaching the meeting; it is surfaced
all the way to JS in `AcsMeetingState.audioSafety`.

Return audio does **not** use ACS playback. Incoming PCM is base64'd to JS and played by
`AudioPlaybackService` / `PcmStreamPlayer`, so it reaches the glasses over A2DP and
participates in MCU duplex via `setOwnAppAudioPlaying`.

## Threads

| Thread | What runs on it |
|---|---|
| `AcsMeetingSession` single-thread executor | join, leave, and every audio-policy application |
| `acs-synthetic-i420` | investigation arm only: generate + emit at fixed fps |
| WebRTC decode thread | the video sink: scale, pack, hand off |
| `acs-i420-send` | `sendRawVideoFrame` and nothing else |
| main looper | the 1 Hz ticker and the WebRTC `getStats` poll |

The rule that matters: **nothing blocking may run on the WebRTC decode thread.** A
`PeerConnection.getStats()` call there once stalled video after roughly one second. The
stats poll is now timer-driven on the main looper, which also means it keeps sampling
during a freeze instead of going quiet exactly when the data is interesting.

## Reading the telemetry

```
adb logcat -s ACS-SPIKE | grep "P6 ladder"
```

One line per second, tracing a frame through every hop:

```
P6 ladder arm=whep 1280x720 recv=14.8 dec=8.1 sink=8.0 dup=4 sub=8.0 wire=8.0 rot=0
  drop{size=0 busy=0 notStarted=0 fail=0 nullI420=0 abandoned=0}
  recv{drop=6 lost=0 nack=0 pli=0 freeze=2 freezeSec=3.4 jit=4.0 decMs=3.2 jbMs=210.0}
  ms{gapP50=68.3 gapP95=523.4 packP95=6.7 scaleP95=0.1 sendP95=4.4}
  chroma{y=162 u=132 v=132} cum{sink=1000 sub=1000 drop=0 inFlight=0}
```

The rates form a ladder, and the first place two adjacent numbers diverge is the bottleneck:

| Field | Hop |
|---|---|
| `recv` | frames WebRTC pulled off the wire (`framesReceived`) |
| `dec` | frames the decoder produced (`framesDecoded`) |
| `sink` | frames our `VideoSink` saw |
| `sub` | frames submitted to ACS |
| `wire` | frames ACS actually encoded (`Features.MEDIA_STATISTICS`) |

So `recv` well under 15 blames the network or Cloudflare; a healthy `recv` with a low `dec`
blames the decoder or jitter buffer; `sink` below `dec` means frames are being dropped
before us; and `sub` below `sink` means we are dropping them, with `drop{}` naming which
reason.

The rest:

- **`cum{}`** is monotonic and is what pass/fail uses. `inFlight` is *derived* as
  `sink - sub - drop`, which makes conservation an identity — a tracked counter cannot be
  read atomically alongside the others and produced false `CONSERVE_FAIL` alarms on a
  perfectly healthy pipeline.
- **`ms{}`** is our own cost. At 15 fps the budget is 66 ms; `pack + scale + send` normally
  sums to around 11 ms. `gapP50` is the real arrival cadence and `gapP95` exposes stalls
  that an average would hide.
- **`chroma{}`** should sit near `u≈v≈128` on neutral content. Values pinned at 0 or 255
  mean the planes are mis-packed, which is the signature of a stride or geometry bug.
- **`dup`** counts refused duplicate track attachments. WebRTC delivers the same track
  through three different observer callbacks as three distinct Java wrappers, so object
  identity cannot dedupe them and `TrackRegistry` keys on `track.id()`. Steady `dup=4`
  (two video, two audio) is correct; climbing `dup` means sinks are being re-added.

`scripts/acs-ladder.ts` in the Mentra-Call repo parses these lines and prints pass/fail
over a trailing 10-second window, including the `recv`-vs-`dec` attribution.

## Tests

```bash
cd mobile/android && ./gradlew :mentra-acs-meeting:testDebugUnitTest
```

These are plain JVM tests with no Robolectric. That constrains what can be tested: ACS SDK
types like `VideoStreamFormat` are native-backed and throw `ExceptionInInitializerError`
outside an Android runtime. The pattern throughout is to keep the logic worth asserting in
a pure class and let the thin SDK-facing wrapper go untested — `I420FormatSpec` holds the
stride arithmetic while `AcsFrameSender.i420Format` just copies it onto the SDK object.

Anything concurrent has a test that actually races it: `SendGateTest` contends the gate,
`RingPercentileTest` writes from multiple threads, and `PipelineStatsTest` reproduces the
counter race that caused the false conservation failures.

## Known gaps

- **Glasses encoder stats are never reported.** The `encoder-stats` event arrives with
  `reported: false`, so the top of the ladder (`src`) stays dark and we cannot yet tell
  whether the glasses are actually producing 15 fps.
- **Outgoing glasses PCM reads as silence** (`P4 pcm meanAbs=0`) and needs its own
  investigation.
- **iOS is foreground-only.** The Swift side under `ios/` does not have the telemetry
  ladder, and Android's audio-routing answers do not transfer — re-verify separately.

The original spike runbook is preserved at [spike/README.md](spike/README.md).
