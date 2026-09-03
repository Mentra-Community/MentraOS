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

`AcsInvestigation.decoderMode` ships as `TEXTURE` (shared EGL, MediaCodec to Surface).
`BYTE_BUFFER` skips the GL readback. A 720p hop on `SM_S948U` decoded in hardware
with `i420P95=0`, but did not clear the campaign gates; keep the flag on TEXTURE.
`AcsInvestigation.zeroCopy` ships off; when on,
tight retainable WebRTC planes go straight to ACS, with an automatic copy fallback.
`AcsInvestigation.pixelFormat` ships as `I420`. `NV12` is the encoder-flip A/B:
advertise and send biplanar NV12 and read `codec=` on the ladder. Revert unless
`codecName` leaves `h264 sw`.

Mentra Call's persisted default is `720p15` (`VideoProfile.DEFAULT = HD`,
1280×720@15 / 2.5 Mbps). `540p15` (960×540@15 / 1.5 Mbps) is a user-selectable
preset on the Home settings picker. It is not migrated onto existing installs
and is not the native default. Miniapp joins pass width, height, fps, and
`maxBitrateBps` through to native, so a selected `540p15` reaches both glasses
WHIP and ACS without changing `VideoProfile.DEFAULT`.

## The pipeline in one picture

```
 glasses ──WHIP──▶ Cloudflare ──WHEP──▶ │ phone (this module)                │ ──▶ ACS ──▶ Teams
                                        │                                    │
   video:  H.264 ─▶ WebRTC decoder ─▶ I420 ─▶ cropAndScale ─▶ I420 copy or NV12 interleave ─▶ sendRawVideoFrame
   audio:  Opus  ─▶ WebRTC decoder ─▶ PCM16 48k ─▶ sendRawAudioBuffer

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
│   ├── MediaListeners.kt        I420Planes, VideoFrameListener, PcmListener
│   ├── GlassesMediaSource.kt    The transport interface + controller. WHEP is one implementation
│   ├── CloudflareWhepSource.kt  The recvonly WHEP subscriber (PeerConnection, sinks, scaling)
│   ├── SyntheticFrameFactory.kt Packed I420 generator (CHEAP / MOTION pan / NOISE)
│   ├── SyntheticI420Source.kt   Fixed-rate GlassesMediaSource wrapping the factory
│   ├── VideoSourceArm.kt        Investigation switch. Ships as WHEP / TEXTURE / I420 / zeroCopy=off
│   └── TrackRegistry.kt         Deduplicates track attachment
│
├── video/                   Downstream — pixels into ACS
│   ├── AcsFrameSender.kt        Owns the RawOutgoingVideoStream and the send executor
│   ├── I420FormatSpec.kt        The I420 format we advertise, as plain values
│   ├── Nv12FormatSpec.kt        The NV12 format we advertise, as plain values
│   ├── AcsTimestamp.kt          100-ns ticks for RawVideoFrame. Zero means freeze.
│   ├── I420Packer.kt            Stride-aware planar copy; planeMinBytes for malformed guards
│   ├── Nv12Packer.kt            I420 → interleaved UV; used only on the NV12 arm
│   ├── FrameGeometry.kt         Buffer-vs-display coordinates under rotation
│   └── SendGate.kt              Single-in-flight backpressure
│
├── audio/                   Two microphones, one call
│   ├── AcsAudioPolicy.kt        Pure decision functions: which stream, who gets muted
│   ├── AudioPolicyApplier.kt    Applies a decision to the live call, with retries
│   └── PcmBridge.kt             Downmix/rebuffer to ACS's 48 kHz mono 20 ms frames
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
2. `toI420()`, then hand the three planes to `AcsFrameSender.sendPlanes` as `I420Planes`.
3. The sender copies each plane once into a pooled ACS buffer (`copyP95`), or — when
   `zeroCopy` is on and the planes are tight, direct, and retainable — retains the
   WebRTC buffer and submits those planes without a copy. The NV12 investigation arm
   always converts: Y is copied, U/V are interleaved, and ACS gets two buffers.

ACS's I420 contract still requires three separate plane buffers. NV12 is two
(Y + interleaved UV). The old pack-then-split path is gone. A timed-out zero-copy
send schedules `release()` after a 1 s grace window so the decoder pool is not starved.

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

### Source health and recovery

The ACS call and the WHEP subscription fail independently: ICE can drop (phone switched
Wi-Fi↔cellular) or the WHEP endpoint can 404 (glasses stopped publishing) while ACS stays
`connected` and Teams holds the last frame. `CloudflareWhepSource` reports every
`SourceState` transition to the session, which:

- carries it on every snapshot as `mediaSource: idle | connecting | live | failed`, so the
  host and miniapp can tell "call up, glasses feed dead" from a healthy call;
- on `failed`, rebuilds the subscription itself with exponential backoff (1 s → 10 s cap) for
  as long as the call is alive. A host `updateVideoSource` with a new URL cancels the retry.

**`LIVE` means a frame reached the sink, not that the WHEP endpoint answered.** The answer
lands before `setRemoteDescription`, before ICE CHECKING and before the first decode — on an
S22 reconnect, 3.2 s before the first frame (`whep_answer` 15:56:47.16, `sub=1.0` 15:56:50.36)
and 6.2 s before a real rate to Teams. Two things followed from promoting on the answer: a
miniapp reading `mediaSource: live` was still ahead of Teams, and a subscription that answered
but never delivered read `LIVE` forever behind a frozen frame with nothing able to see it.

So the answer arms `FirstFrameGate` and stays `CONNECTING`. The first video frame for that
peer generation promotes to `LIVE` (`first_frame`); if none arrives within
`FIRST_FRAME_TIMEOUT_MS` (9 s) the source transitions `FAILED` with reason `no_first_frame`
and the backoff above rebuilds it. An ICE bounce back to CONNECTED returns the source to
`CONNECTING` and rearms rather than claiming `LIVE`: a recovered candidate pair is a promise
of frames, and if media was already flowing the next frame promotes within milliseconds.

`canReuseSource` is why a same-URL `restart` during `CONNECTING` is still a no-op: rebuilding
a subscriber seconds from its first frame only restarts the wait, and `CONNECTING` is bounded
by the POST timeout and the first-frame deadline, so nothing can strand there.

`restartVideoSource()` forces a rebuild on the current URL even when the peer still looks
healthy; the host calls it from a NetInfo listener when the phone's network identity changes.

iOS `WhepVideoSource` mirrors all of this. `sub=` on the P6 ladder is the ground truth for
"Teams has video"; `first_frame` is the transition that should sit next to it in logcat.

## Audio path

Two possible microphones — the glasses or the handset — and the wrong answer means either
silence or the wearer being recorded when they think they are muted. The decision is
therefore a pure function in `AcsAudioPolicy`, unit-tested in isolation, and separate from
the code that applies it.

- **`audioSource: "glasses"`** arms a `RawOutgoingAudioStream` — which ACS reports as
  `VIRTUAL_OUTGOING` — and feeds it WHEP PCM through `PcmBridge`, which downmixes to mono
  48 kHz (passthrough when WHEP already decoded at 48 kHz) and re-chunks into the 20 ms
  frames ACS expects. The handset mic is never opened. Incoming raw audio stays 16 kHz.
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
P6 ladder arm=whep 1280x720 recv=14.8 dec=8.1 sink=8.0 dup=4 sub=8.0 wire=1280x720@8.0 kbps=1400 codec=h264_sw rot=0
  drop{size=0 busy=0 notStarted=0 fail=0 nullI420=0 abandoned=0}
  recv{drop=6 lost=0 nack=0 pli=0 freeze=2 freezeSec=3.4 jit=4.0 decMs=3.2 jbMs=210.0 decImpl=OMX.qcom.video.decoder.avc}
  path{mode=texture copy=planes pix=i420} buf{tex=12 i420=0 other=0}
  stride{y=1280 u=768 v=768 tight=0 padded=12} zc{on=0 used=0 fell=0 padded=0 heldMax=0 timeout=0}
  ms{gapP50=68.3 gapP95=523.4 i420P95=12.0 packP95=na scaleP95=na sinkCbP95=20.0 splitP95=na copyP95=4.1 sendP95=2.7}
  alloc{dest=0 plane=3} chroma{y=162 u=132 v=132} cum{sink=1000 sub=1000 drop=0 inFlight=0}
  cpu{proc=112.4 cores=8}
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
- **`ms{}`** is our own cost. At 15 fps the budget is 66 ms. `i420P95` is `toI420()`
  (GL readback when `path.mode=texture`; libyuv when `bytebuf`). `copyP95` is the single
  plane copy into ACS buffers. `packP95`/`splitP95` stay in the line for old captures
  and print `na` on the planes path. `sinkCbP95` is the whole decode-thread callback.
- **`path{}` / `buf{}` / `stride{}` / `zc{}`** say which arm produced the line. `buf.tex`
  climbing with `mode=texture` is the Surface decoder. `buf.i420` climbing with
  `mode=bytebuf` is the A/B succeeding. `pix=nv12` plus `copy=nv12` is the encoder-flip
  arm. `codec=` is ACS `OutgoingVideoStatistics.codecName` — the NV12 experiment
  succeeds only if this leaves `h264_sw`. `stride.padded` dominating means zero-copy will
  fall back (tight-plane only). `decImpl` turning into a software name is an abort for
  the byte-buffer arm.
- **`cpu{proc}`** is process CPU% the same way `top` reports it (can exceed 100 on
  multi-core). Pair it with the `ms{}` stages: high `i420`/`sinkCb` + high `proc` supports
  convert-on-decode-thread; high `sendP95` with low `i420` blames ACS encode/submit.
  Preview is JS/UI and is not in this line — toggle it and watch `cpu{proc}`.
- **`alloc{}`** counts dest/plane direct-buffer allocations. After the first frames these
  should stay flat if pooling holds. Climbing values mean we are still allocating per frame.

A/B capture (preview off, ~90 s of steady motion, same room):

```bash
adb logcat -c
# join the Teams call, hold steady motion
adb logcat -d -s ACS-SPIKE > /tmp/acs-<arm>.txt
bun scripts/acs-ladder.ts --compare /tmp/acs-baseline.txt /tmp/acs-<arm>.txt --skip-ms 20000
```

Compare uses medians, not the last tick. A 15% `recv` gap or a 2x `lost` gap prints a
confound warning: the network differed and the CPU delta is not attributable. Capture
order is baseline (texture + planes, `zeroCopy=false`, `pixelFormat=I420`) first,
then one flag at a time. The NV12 encoder-flip is `pixelFormat=NV12`; keep it
only if `codec=` leaves `h264_sw`.

### 540p15 + BYTE_BUFFER campaign (operator steps)

`720p15` stays the Home and native default. `540p15` is selectable. Arms 1–2
were captured on `SM_S906U` (Snapdragon, not the A54) with preview off,
`pixelFormat=I420`, `zeroCopy=false`. Loss on the 720p window was >2× the 540p
window, so the CPU delta is **not** attributable. Wire fps is.

Hold these constants for arm 3: same phone, same network, same Teams meeting,
same ~90 s walking/head-turn motion after a 20 s warmup, preview off, picker
still on `540p · 15 fps`.

Confirm the join logs before saving each dump:

- glasses WHIP: `whip start (1280x720@15)` or `whip start (960x540@15)`
- miniapp ACS handoff: `requestedAcs=1280×720 @15` or `requestedAcs=960×540 @15`
- native: `P5 negotiated ... 1280x720 fps=15` or `P5 negotiated ... 960x540 fps=15`
- ladder: `wire=1280x720@...` or `wire=960x540@...`

**Arm 1 — 720p15 / TEXTURE (baseline).** Leave Glasses video on `720p · 15 fps`.
Confirm `AcsInvestigation.decoderMode` is still `TEXTURE`. Clear logcat, join,
hold motion, dump:

```bash
adb logcat -c
# join Teams on the A54, 90 s of steady motion, preview off
adb logcat -d -s ACS-SPIKE > /tmp/acs-720p15-texture.txt
```

Leave the call.

**Arm 2 — 540p15 / TEXTURE (resolution savings).** On Home → Glasses video, select
`540p · 15 fps`. The summary under the picker should read
`960×540 @ 15 · 1.5 Mbps`. Decoder stays `TEXTURE`. Rejoin the same meeting,
same motion, dump `/tmp/acs-540p15-texture.txt`. Leave.

Compare resolution-only savings (still no decoder flip):

```bash
bun scripts/acs-ladder.ts --compare /tmp/acs-720p15-texture.txt /tmp/acs-540p15-texture.txt --skip-ms 20000
```

Recorded on `SM_S906U` 2026-09-01 (medians, 20 s warmup on 540p; 720p is the
long 15:52 window). `recv` matched (14.9 vs 14.8). `lost` 39 → 7 (confound).

| field | 720p15 / TEXTURE | 540p15 / TEXTURE |
|---|---:|---:|
| recv | 14.9 | 14.8 |
| dec / sink / sub | 11 / 11 / 11 | 12.9 / 12 / 12 |
| wire fps | 8.6 | 13.2 |
| kbps | 1332 | 1357 |
| i420P95 / sinkCbP95 / copyP95 | 10.9 / 16.8 / 5.4 | 10.1 / 14.7 / 3.9 |
| cpu{proc} | 109 | 95 (confounded) |
| decImpl | `c2.qti.avc.decoder` | `c2.qti.avc.decoder` |
| codec | `h264_sw` | `h264_sw` |

Wire is the win: same ~1.4 Mbps, ~9 → ~13 fps. Encoder stayed software. Keep
540p15 selectable; do not make it the default.

**Arm 3 — 540p15 / BYTE_BUFFER (decoder savings).** Keep the picker on 540p15.
Flip `AcsInvestigation.decoderMode` to `BYTE_BUFFER` locally. Rebuild native,
rejoin, dump `/tmp/acs-540p15-bytebuffer.txt`. Leave.

```bash
bun scripts/acs-ladder.ts --compare /tmp/acs-540p15-texture.txt /tmp/acs-540p15-bytebuffer.txt --skip-ms 20000
```

Recorded on `SM_S948U` 2026-09-01 at **720p15** (wrong profile vs the plan;
different SoC vs arms 1–2). Mechanical decode passed; campaign gates did not.

| field | 720p15 / BYTE_BUFFER (`SM_S948U`) |
|---|---:|
| path / buf | `bytebuf`, `tex=0`, `i420` climbing |
| recv / dec / sink | 15 / 15 / 15 |
| i420P95 / sinkCbP95 / copyP95 | 0.0 / 1.0 / 0.4 |
| cpu{proc} | ~44 (not comparable to SM_S906U ~109) |
| decImpl | `c2.qti.avc.decoder` |
| wire / codec | `na` / `na` |
| drop.busy | climbing (~18–34) |

Do not promote BYTE_BUFFER: no wire fps, no `codec=`, busy backpressure, and
no same-phone 540p TEXTURE compare. `decoderMode` stays `TEXTURE`.

Promote BYTE_BUFFER as the guarded default only when every gate passes:

- `path{mode=bytebuf}`, `buf{i420}` rises, and `buf{tex}=0`
- `recv` differs by at most 15% and packet loss by at most 2× (else confounded)
- `decImpl` stays hardware (`OMX.qcom`, `c2.qti`, vendor). Abort on
  `c2.android`, `c2.google`, `OMX.google`, or a blank/stalled decoder
- median process CPU improves by at least 8 percentage points;
  `i420P95`/`sinkCbP95` improve; `wire` does not regress by more than 5%
- no malformed frames, busy/fail drops, chroma corruption, or remote freezes

If it fails, revert only `decoderMode` to `TEXTURE`. 540p15 stays a selectable
Home preset. Switching Glasses video back to `720p · 15 fps` is the profile
rollback; it takes effect on the next join.

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
  iOS also has no `RemoteRoster` yet (`participants` is never emitted) and does not apply
  `maxBitrateBps` to the outgoing stream.

The original spike runbook is preserved at [spike/README.md](spike/README.md).
