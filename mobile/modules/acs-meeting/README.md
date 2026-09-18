# @mentra/acs-meeting

Phone-native Azure Communication Services client that puts a MentraOS wearer into a
Microsoft Teams meeting as a guest. The glasses provide the camera and the microphone;
the phone does all the WebRTC and ACS work.

This document is the reference for the native side, with an Android bias because Android
is where the full pipeline, the telemetry and the SoftAP transport are implemented. iOS
differences are collected in [iOS](#ios).

## Contents

- [Mental model](#mental-model)
- [Where the code lives](#where-the-code-lives)
- [Host setup](#host-setup)
- [The two transports](#the-two-transports)
- [The JS ↔ native boundary](#the-js--native-boundary)
- [Operations](#operations)
- [Video send path](#video-send-path)
- [Audio uplink path](#audio-uplink-path)
- [Audio downlink path](#audio-downlink-path)
- [Networking on Android](#networking-on-android)
- [State model](#state-model)
- [Recovery](#recovery)
- [Threads and concurrency](#threads-and-concurrency)
- [Generations and stale callbacks](#generations-and-stale-callbacks)
- [Investigation arms](#investigation-arms)
- [Telemetry](#telemetry)
- [A/B captures on record](#ab-captures-on-record)
- [Tests](#tests)
- [iOS](#ios)
- [Known gaps](#known-gaps)

## Mental model

**The phone is a relay, not a capture device.** It receives what the glasses already
encoded, decodes it, and re-publishes it into ACS. Production never generates pixels on
the phone, and no video frame ever crosses the JavaScript bridge.

```
glasses ──H.264 over WHIP──▶ [SoftAP listener | Cloudflare] ──▶ phone decode ──▶ ACS ──▶ Teams
```

Two properties of this are load-bearing and easy to get wrong.

**ACS encodes for us.** `RawOutgoingVideoStream` accepts raw pixels only — `I420`, `NV12`,
`RGBA` and a few others — never an H.264 bitstream. The glasses' H.264 cannot be forwarded
as-is; it must be decoded and handed over as pixels, and ACS then re-encodes to H.264
internally. The decode is unavoidable; the *conversion* is not, which is why we feed I420
(what the WebRTC decoder already produces) rather than converting to RGBA.

**Only the video path is hot.** At 720p15 the video path moves ~1.4 MB per frame, 15 times
a second. Everything in `video/` and `source/` is written to avoid per-pixel work in
Kotlin: scaling is libyuv via `cropAndScale`, packing is a bulk `ByteBuffer` copy, and
plane buffers are pooled rather than allocated.

Audio is the opposite: small buffers, but two possible microphones and a mute that must
mean the same thing at every stage. That is why the audio decision is a pure function,
tested in isolation, and separate from the code that applies it.

## Where the code lives

The native work is split across two Expo modules. `glasses-media` has **no ACS dependency**
— it transports and decodes glasses media, and is also used by the managed WebRTC
livestream relay. `acs-meeting` owns everything ACS-shaped.

```
mobile/modules/acs-meeting/android/src/main/java/com/mentra/acsmeeting/
├── AcsMeetingModule.kt       Expo bridge. Owns the scoped network + cellular hold
├── AcsMeetingSession.kt      Orchestrator. Owns the ACS Call and wires everything together
├── AbandonedCallAgent.kt     Recovers a CallAgent from a sign-in we stopped waiting on
├── CallCapabilities.kt       CapabilityStatus + EndForEveryonePolicy
├── RemoteRoster.kt           Remote participants, coalesced into state snapshots
│
├── source/
│   └── MeetingVideoSourceSpec.kt   Sealed Whep | SoftAp | Synthetic, parsed at the bridge
│
├── video/                    Pixels into ACS
│   ├── AcsFrameSender.kt         Owns RawOutgoingVideoStream, the send executor and the pool
│   ├── SendGate.kt               Single-in-flight backpressure
│   ├── FramePacer.kt             Absolute-schedule time gate at the advertised fps
│   ├── VideoProfile.kt           Geometry + rate + bitrate ceiling. One source of truth
│   ├── I420FormatSpec.kt         The I420 format we advertise, as plain values
│   ├── Nv12FormatSpec.kt         The NV12 format we advertise, as plain values
│   ├── Nv12Packer.kt             I420 → interleaved UV; NV12 arm only
│   └── AcsTimestamp.kt           100-ns ticks. Zero means freeze
│
├── audio/                    Two microphones, one call
│   ├── AcsAudioPolicy.kt         Pure decisions: which stream, who is muted, PCM routing
│   ├── AudioPolicyApplier.kt     Applies a decision to the live call, with convergence retries
│   ├── AudioUplinkChain.kt       Ingest + delay + bridge + pacer behind one lock
│   ├── PcmBridge.kt              Downmix/resample to 48 kHz mono 20 ms frames
│   ├── PcmResampler.kt           Stateful resampler (filter history spans callbacks)
│   ├── UplinkPacer.kt            Clock-domain ring; locks buffer depth to a target
│   ├── UplinkSender.kt           Monotonic-deadline drain thread + AcsUplinkTransport
│   ├── PhoneMicCapturer.kt       AudioRecord, for the phone-mic source
│   ├── IncomingAudioPump.kt      ACS mixed audio → 16 kHz mono batches for the host
│   └── IncomingRateProbe.kt      Measures the real incoming rate vs the declared one
│
└── telemetry/
    ├── CallDiagnostics.kt        Sampling cadence + bitrate thresholds for the analyzer
    └── WireEpisodeTracker.kt     Names each stretch where the ACS uplink went bad
```

```
mobile/modules/glasses-media/android/src/main/java/com/mentra/glassesmedia/
├── source/
│   ├── GlassesMediaSource.kt     Interface, SourceKind/SourceState, controller, reuse policy
│   ├── LocalWhipIngestSource.kt  SoftAP: we answer the glasses' WHIP offer
│   ├── CloudflareWhepSource.kt   WHEP: we offer, Cloudflare answers
│   ├── WhipIngestServer.kt       The HTTP listener the glasses POST to
│   ├── WhipIngestProtocol.kt     Paths and status semantics (including the 410 tombstone)
│   ├── SoftApSdpGuard.kt         Rejects offers whose candidates leave the hotspot
│   ├── SoftApIcePolicy.kt        ICE configuration for a local-only link
│   ├── DecodedTrackRelay.kt      The VideoSink/AudioTrackSink. Scale, toI420, hand off
│   ├── TrackRegistry.kt          Deduplicates track attachment by track id
│   ├── FirstFrameGate.kt         Promotion to LIVE on a real frame, per peer generation
│   ├── FrameStallGate.kt         Detects a frozen decoder mid-call
│   ├── MediaListeners.kt         I420Planes, VideoFrameListener, PcmListener
│   ├── VideoSourceArm.kt         MediaDiagnostics: every investigation flag
│   └── Synthetic*.kt             Locally generated frames, investigation arm only
├── network/
│   ├── ScopedSoftApNetwork.kt    Joins the glasses hotspot as an internet-less network
│   ├── ScopedNetworkChangeDetector.kt  Makes libwebrtc see that network
│   ├── InternetHold.kt           Cellular request + process pin + default-network waits
│   └── NetworkFacts.kt           Bounded, readable network state for traces
├── video/
│   ├── I420Packer.kt             Stride-aware planar copy; planeMinBytes guards
│   └── FrameGeometry.kt          Buffer-vs-display coordinates under rotation
├── telemetry/
│   ├── PipelineStats.kt          Every counter, and the 1 Hz "P6 ladder" line
│   ├── PipelineTicker.kt         Emits the ladder, P7 rate, P9 quality and AVSYNC each second
│   ├── VideoRateVerdict.kt       "P7 rate" — what is actually binding the wire rate
│   ├── VideoQuality.kt           "P9 quality" — bits per pixel band
│   ├── AvSyncProbe.kt            Clap correlator: audio lead vs video luma at ingest
│   ├── ChromaProbe.kt            Plane averages, to catch a mis-packed frame
│   └── RingPercentile.kt         p50/p95 over a fixed ring, written from many threads
└── trace/
    └── SoftApTrace.kt            `SOFTAP_TRACE` stage/failure lines with a shared trace id
```

Tests mirror both trees under `android/src/test/java/...`.

Dependency direction is `AcsMeetingSession → {source, video, audio, telemetry}` and
`acs-meeting → glasses-media`, never the reverse. Nothing in `audio/` touches video.

The JS host that drives all of this lives in `mobile/modules/engine/src/services/`:
`AcsMeetingService.ts` (the one owner of the native module), `SoftapCallTransport.ts`
(SoftAP sequencing only), and `LocalMiniappRuntime.ts` (the `MEETING_*` miniapp requests).

## Host setup

Add `"@mentra/acs-meeting"` to the host's Expo `plugins` list, including when this module
is installed through `@mentra/engine`, then run Expo prebuild for the target platform. The
plugin enables Android core library desugaring and builds `AzureCommunicationCommon` as the
dynamic framework ACS requires on iOS. These requirements apply even when the host does not
use Crust or Mapbox.

For iOS, run `expo prebuild --platform ios` and `pod install`. The plugin builds only
`AzureCommunicationCommon` as a dynamic framework with `BUILD_LIBRARY_FOR_DISTRIBUTION=YES`.
Calling's binary requires that framework at runtime and imports its generated Swift header
and stable module interface at build time; CocoaPods' default static-library layout cannot
satisfy that contract. The host's other pods retain their configured linkage.

## The two transports

A call picks exactly one, at join, via `videoSource`.

### SoftAP — the Mentra Call production path

The glasses raise a hotspot. The phone joins it as a **scoped, internet-less network** while
keeping cellular for Teams. The glasses then publish WHIP straight to a listener on the
phone. Cloudflare is not involved at all.

The phone is the **answerer** here, and the ingest URL is an *output* of binding a listener,
not an input. That single fact explains most of the SoftAP design: the URL cannot be known
before the join, so `join()` must bind before it returns, and recovery cannot silently
rebind to a new port the glasses were never told about.

SoftAP publishes **video only** (`captureAudio=false`). The wearer's voice takes BLE LC3
instead — see [Audio uplink path](#audio-uplink-path).

### Cloudflare WHEP

The glasses publish WHIP to Cloudflare; the phone subscribes with WHEP. The phone is the
**offerer** and the URL is an input. This is the path that supports `updateVideoSource` and
in-session automatic rebuilds.

### What differs

| | SoftAP | Cloudflare WHEP |
|---|---|---|
| Phone role | answerer | offerer |
| Ingest URL | output of `join` / `rebindSoftApIngest` | input to `join` |
| Wearer audio | BLE LC3 via `pushOutgoingPcm` | decoded WHIP audio track |
| First-frame deadline | 6 s (no CDN, no WAN hop) | 9 s |
| Source reuse | never | same URL and not `FAILED` |
| Session-level auto rebuild | suppressed | exponential backoff, 1 s → 10 s |
| Needs cellular | yes, validated before the join | no |

Everything downstream of the decoder is identical. `DecodedTrackRelay` is shared, so past
the decode there is no such thing as "the SoftAP path".

## The JS ↔ native boundary

Expo module name: **`MentraAcsMeeting`**. Every `AsyncFunction` is wrapped in an
entry/exit trace (`native_<name>_begin` / `_end` / `_failed`) so a stall can be attributed
to the native side rather than to the bridge.

### Events

| Event | Payload | Meaning |
|---|---|---|
| `onState` | full state snapshot | Any phase, roster, media-source, capability or audio-safety change |
| `onIncomingPcm` | `{base64, sampleRate, channels}` | 16 kHz mono batch of Teams audio for the host to play |
| `onScopedNetworkLost` | `{code, message}` | The hotspot went away **while we still wanted it** |

`onScopedNetworkLost` never fires for a hotspot we released ourselves; the scoped state
machine drops the framework's `onLost` in that case, so a normal Leave or End cannot
manufacture a mid-call network error.

### Functions

Call lifecycle:

| Function | Notes |
|---|---|
| `prepareAgent({token, displayName})` | Sign in to ACS **before** the hotspot exists. Waits up to 60 s |
| `join(options)` | Joins Teams and arms all streams. Returns the snapshot plus `ingestUrl` on SoftAP |
| `leave()` | Queues cleanup and returns immediately |
| `leaveAndAwait({timeoutMs})` | Resolves only once cleanup finished. `{completed}` |
| `endForEveryone()` | Ends the group call. Tears this device down either way |
| `getState()` | Current snapshot |

Audio and video control:

| Function | Notes |
|---|---|
| `setMuted(muted)` | Gates the uplink chain synchronously, then applies ACS policy |
| `setAudioSource(source)` | **No-op.** The source is locked for the call at join |
| `pushOutgoingPcm(base64, rate, ch)` | Synchronous `Function`, ~100 calls/s. Returns whether it entered the uplink |
| `updateVideoSource(whepUrl)` | WHEP only |
| `restartVideoSource()` | Forces a WHEP rebuild. Ignored for SoftAP |

SoftAP and networking:

| Function | Notes |
|---|---|
| `isWifiEnabled()` | Read-only preflight. We never open the Wi-Fi panel |
| `joinScopedNetwork(ssid, passphrase)` | Validates cellular first, then joins. Returns the phone's IPv4 |
| `leaveScopedNetwork()` | Drops **only** the hotspot bind, never the cellular pin |
| `awaitValidatedDefaultNetwork()` | `{transport, validated, present, usable, detail}` |
| `scopedNetworkInfo()` | `{available, localIpv4, prefix}` |
| `probeScopedGateway()` | Blocking TCP probe, `{reachable, detail}` |
| `rebindSoftApIngest()` | Destroys the listener generation and binds a new one. Returns the new URL |
| `awaitIngestClosed({timeoutMs})` | Has the retiring listener released its port? |
| `forceCloseIngest()` | Skip the tombstone. Only after a timed-out wait |
| `beginTrace(traceId)` | Shares the host's trace id with native logs |

`join` options: `meetingUrl`, `token`, `videoSource` (`{type:"whep",url}` or
`{type:"softap",bindAddress}`; a bare `whepUrl` still works for older hosts), `displayName`,
`audioSource`, `audioDelayMs`, `video` (`{width,height,fps,maxBitrateBps}`), `origin`,
`dumpPcmWav`. A malformed `videoSource` or `video` throws at the bridge, where the message
names the field, rather than surfacing later as a call that joins and shows nothing.

### Module lifecycle

`OnCreate` installs `ScopedNetworkChangeDetector` **before any `PeerConnectionFactory`
exists in the process**. libwebrtc's network monitor only reads the detector factory when it
starts, and without it libwebrtc never sees the internet-less hotspot, so the phone's WHIP
answer has no host candidate.

`OnDestroy` (a reloaded JS bundle, or a killed module) leaves the session, releases the
scoped network, and permanently closes the cellular hold. It is traced, because nothing on
the host side will ever report it.

## Operations

### Join — SoftAP

Order is the whole point. Publishing before the ACS join means decoded frames can arrive
before the raw outgoing streams exist, and the first frames are dropped by whatever happens
to be null at the time.

```
1 hotspot      glasses raise the AP                     (host + BLE)
2 scopedJoin   phone joins it, cellular validated first (joinScopedNetwork)
3 acsJoin      bind WHIP listener, then join Teams      (join → ingestUrl)
4 publish      tell the glasses where to POST           (phoneStreamCoordinator)
5 live         wait for a decoded frame                 (mediaSource: live)
```

`SoftapCallTransport.ts` owns that sequence and nothing else: the session owns the listener
and the peer, `PhoneStreamCoordinator` owns the publisher, and the scoped network is owned
by native. Every step has exactly one owner that can tear it down, which is what makes
leaving mid-join safe.

`join` sets `phase = "connecting"` synchronously, so the resolved snapshot cannot be an
`idle` that overwrites a fresher `onState`. Everything below then runs on the session
executor:

1. `leaveLocked(emitIdle = false, keepAgent = reuseAgent)` tears down any previous call
   *without* announcing idle — the caller already holds a `connecting` snapshot, and an idle
   landing after it made the UI flash out of "joining" on every join. That teardown bumps
   `joinGeneration` itself, so the generation for this join is read afterwards.
2. Resolve the `VideoProfile` through `MediaDiagnostics.outgoingRate`, and publish
   `advertisedFps` / `budgetBps` to the stats so the 1 Hz verdict can score the wire against
   what we declared.
3. Build `PcmBridge`, choose the pacer headroom (`LC3_TARGET_MS` 160 ms for SoftAP glasses
   audio, otherwise `TARGET_MS` 60 ms), and build the `AudioUplinkChain`.
4. Reuse the prepared `CallAgent` if `prepareAgent` ran; otherwise `createCallAgent` now.
5. Arm `VirtualOutgoingVideoStream` with `AcsFrameSender.outgoingFormat(profile)` and attach
   the sender. The format listener pushes the negotiated size back to the source.
6. Arm `RawOutgoingAudioStream` (PCM16, 48 kHz, mono, 20 ms) and `RawIncomingAudioStream`
   (PCM16, 16 kHz, mono). The incoming listener feeds `IncomingAudioPump`.
7. **SoftAP only:** bind the WHIP listener, with the cellular process pin lifted for exactly
   that call, before the Teams join. The Expo promise cannot return without `ingestUrl`.
8. `callAgent.join(context, TeamsMeetingLinkLocator(url), joinOptions)`, attach the roster,
   and push the first call state.

`OutgoingVideoConstraints` carry the profile's max width, height, fps and bitrate.
`OutgoingAudioOptions` always uses the raw stream with `setCommunicationAudioModeEnabled(false)`:
communication mode makes the ACS SDK call `setMode(3)` on connect and request the phone
speaker, which yanks A2DP off the glasses. `IncomingAudioOptions` must **not** be muted —
that flag gates the very stream we read from.

### Join — WHEP

No sequencer. `AcsMeetingService.join` goes straight to native with a URL, and
`CloudflareWhepSource` offers, POSTs and subscribes. The glasses were already publishing
from a separate stream start.

### prepareAgent, and why it exists

`createCallAgent` after the scoped join sat for the full 20 s deadline on device and only
completed once SoftAP was released — glasses dnsmasq cannot resolve ACS hosts. Token mint
already proved the internet worked *before* the hotspot, so signing in there makes the later
SoftAP join a media bind plus a meeting join rather than another sign-in through a broken
resolver.

It waits `PREPARE_AGENT_WAIT_MS` (60 s), sized off a cold sign-in measured at ~35 s on a
544 ms-RTT access point, and it deliberately returns **still pinned to cellular**. ACS
re-binds its signalling when the network moves and keeps whatever route it got, so the pin
has to survive the hotspot join. Teardown drops it, and only once a validated default
internet exists.

### Leave

`leave()` bumps the generation, queues `leaveLocked` and returns. `leaveAndAwait(timeoutMs)`
does the same but blocks on a latch and **rethrows failures that `leaveLocked` would
otherwise only log** — reporting a clean teardown that did not happen is exactly what lets
the next call build on leaked state.

`leaveLocked` invalidates the generation first, then releases in named groups so a throw can
be attributed: `telemetry` (ticker, diagnostics, media stats, capabilities, roster) →
`audio` (phone mic, uplink, pumps, applier, chain) → the call, agent and media source. A
dozen releases share one `try`, and the breadcrumb is what turns "leave cleanup failed" into
a location.

Hang-up is bounded at `HANGUP_WAIT_MS` (8 s). That Future has no timeout of its own, and on
the single session executor an unbounded `get()` is the hang that made Cancel sit on
"Leaving the meeting" while the next join queued behind the same stuck hang-up.

On the JS side, a SoftAP leave is not just a hang-up: `retireSoftapAttempt` also stops the
glasses publisher, releases the hotspot and drops the cellular pin.

### End for everyone

Teams grants this to presenters only, and ACS surfaces it as the runtime capability
`HANG_UP_FOR_EVERYONE`. `EndForEveryonePolicy.refusalFor` refuses locally only when the
capability is **known** to be denied; unknown is the ordinary state before the first
capabilities event and letting the service decide is more honest than guessing.

Bounded at `END_FOR_EVERYONE_WAIT_MS` (15 s). Local teardown runs either way, so a rejection
means "we could not end it for the others", never "you are still in it".

### Mute

Mute is **not** a microphone switch. The glasses mic keeps running; the uplink is gated.

`setMuted` calls `uplinkChain.mute()` **before** the executor hop, because muting is the one
audio operation whose latency the wearer can hear as a mistake and the policy queue can be
several ACS round trips deep. The chain's mute is atomic against ingest and clears the delay
ring, the resampler's filter history, the partial 20 ms frame and the pacer ring in one lock
— clearing them one at a time leaves whichever stage the producer thread was writing to, and
an unmute would then resurrect words the wearer said while muted.

It cannot be instantaneous at the far end: buffers ACS already accepted cannot be recalled.
That residual is bounded by `UplinkSender.MAX_IN_FLIGHT` (10 frames) and **measured**, not
assumed — `muteTailMs` on the `P8 audio-up` line.

`UplinkSender` also re-reads the mute flag immediately before every submission and
substitutes a silence frame rather than nothing, because a gap is a glitch on the far end
while silence is a mute.

### Participants

Push, not poll. `RemoteRoster` attaches a `ParticipantsUpdatedListener` plus per-participant
listeners for state, mute, speaking and display name. `isSpeaking` flips several times a
second, so changes are coalesced into one snapshot per `ROSTER_COALESCE_MS` (150 ms) burst
rather than a storm of events.

Every participant read is individually wrapped: an ACS getter that throws must not take out
the whole roster. Identity is `identifier.rawId`, with a stable fallback, and the snapshot is
sorted by id so an unchanged roster serializes identically.

### Get state

`snapshot()` is the single shape everything emits: `state`, `muted`, `provider`,
`audioSource`, `activeStream`, `audioSafety`, `mediaSource`, `participants`, `capabilities`,
plus optional `meetingUrl`, `error`, `ingestUrl` and flattened `endReason_code` /
`endReason_subcode` / `endReason_message`. The end reason is flattened because the Expo
bridge drops nested nulls.

## Video send path

### Once, at join

`VideoProfile` is the single source of truth for geometry, rate and bitrate ceiling. The
declared ACS format, the outgoing constraints and the source's target size all read from it
so they cannot drift apart.

Drift is not cosmetic. ACS runs a rate controller over a fixed bitrate budget and its only
levers are quality and dropped frames. Advertise 30 and send 15, and it reserves budget for
frames that never arrive; the wire rate collapses while our own counters look healthy.

| Profile | Geometry | Notes |
|---|---|---|
| `HD` = `DEFAULT` | 1280×720 @ 15, 3 Mbps | Mentra Call's persisted default |
| `P540_15` | 960×540 @ 15, 3 Mbps | Selectable Home preset. Not migrated onto existing installs |
| `P540` | 960×540 @ 30, 3 Mbps | |
| `SD` | 640×360 @ 15, 1 Mbps | A quarter of `HD`'s encode work |

The ACS ceiling sits above the glasses→phone WHIP default (2.5 Mbps) so Teams is not the
bottleneck on the easy hop. Miniapp joins pass width, height, fps and `maxBitrateBps`
through, so a selected `540p15` reaches both the glasses WHIP config and ACS without
changing `VideoProfile.DEFAULT`.

`AcsFrameSender.attach` listens for `STARTED` and for format changes, and pushes the
negotiated size into the source through `onFormat` → `media.setTargetSize`. Until ACS
negotiates, frames pass through unscaled. Both listeners check stream identity first, so a
late `STOPPED` from a previous call cannot freeze outgoing video for the current one.

### Per frame, on the WebRTC decode thread

`DecodedTrackRelay.videoSink`:

1. `onPromotableFrame()` — the first frame of this peer generation flips `FirstFrameGate`
   and the source goes `LIVE`.
2. `FrameGeometry.packSize(buffer.width, buffer.height, frame.rotation)`. **Buffer
   coordinates, never display coordinates**: `rotatedWidth`/`rotatedHeight` overrun the I420
   planes whenever rotation is 90° or 270°. A non-zero rotation is logged once and counted as
   `rot=` on the ladder rather than silently corrupting.
3. Scale only if ACS negotiated a different size, with `buffer.cropAndScale(...)` — libyuv,
   not Kotlin. `needsScale` is a pure, tested function because getting it backwards is
   invisible: an unnecessary scale is a silent CPU cost and a skipped one is a plane-size
   mismatch at the sender.
4. `toI420()`. On the shipped `TEXTURE` decoder mode this is a GL readback (`i420P95`).
5. Hand three planes to the listener as `I420Planes`, carrying `retain`/`release` so the
   sender can keep them past the callback.
6. `finally`: release the I420 buffer and any scaled buffer, and record `sinkCbP95`.

### `AcsFrameSender.sendPlanes`

A frame can be dropped before it ever reaches ACS. Each reason has a counter in the
ladder's `drop{}` block:

| Ladder field | Cause | Raised by |
|---|---|---|
| `nullI420` | `toI420()` returned null | relay |
| `notStarted` | Stream not `STARTED`, or no negotiated format yet | sender |
| `size` | Plane size ≠ negotiated size | sender |
| `pace` | `FramePacer` says this frame is early | sender |
| `busy` | `SendGate` already has a send in flight | sender |
| `fail` | Submit threw, **or** a plane was shorter than `planeMinBytes` | sender |
| `abandoned` | The send timed out and its buffers were not reclaimed | sender |

Note that malformed-plane drops fold into `fail`; the distinguishing evidence is the
`P5 send plane too small` warning, not a separate counter.

**`FramePacer` is the time gate.** `sendRawVideoFrame` returns in about a millisecond, so
without it we hand ACS every frame the decoder produces and ACS's encoder has to drop them —
which is the over-reservation that collapses the wire bitrate. It keeps an **absolute**
schedule rather than measuring from the last admit: a "has the interval elapsed since the
last admit" test turns a 14.6 fps source into exact 2:1 decimation, which was observed on
device as `sub=7.0` against an advertised 8. A frame more than two intervals late resyncs
instead of replaying the debt as a burst.

**`SendGate` is the concurrency gate**, and only that: exactly one send in flight, no time
component. `busyCount` is the backpressure signal.

`prepareSend` copies each plane once into a pooled direct `ByteBuffer` (`copyP95`), keyed by
exact capacity — luma and chroma differ 4×, and a single queue made a luma borrow evict a
chroma buffer it could not use. The NV12 arm copies Y and interleaves UV into two buffers
instead. Zero-copy retains the WebRTC buffer and submits its planes directly, but only when
the planes are tight, direct, retainable and fewer than `MAX_HELD` (2) are outstanding.

The actual submit runs on the `acs-i420-send` thread with a 200 ms timeout. Two subtleties:

- **A timed-out send does not release its buffers.** `Future.get(timeout)` does not cancel
  the work, so ACS may still be reading those planes. Pooled buffers are deliberately leaked
  and counted as `abandoned`; a zero-copy retain is released after a 1 s grace window so the
  decoder pool is not starved.
- **Timestamps are Windows ticks** (100 ns). Zero means "no time", and a run of those makes
  the Teams jitter buffer hold the last picture — a random-looking freeze. `AcsTimestamp`
  prefers the stream clock when ACS is advancing it, falls back to capture time, and always
  emits a tick strictly after the last one.

## Audio uplink path

### Choosing the microphone

The wrong answer means either silence or a wearer recorded when they think they are muted,
so the decision is a pure function in `AcsAudioPolicy` and is separate from the code that
applies it.

**Both sources feed `RawOutgoingAudioStream`.** `planJoin` always returns `armVirtual = true`.
`LocalOutgoingAudioStream` is deliberately not used: it hands ACS the audio route
(`MODE_IN_COMMUNICATION` plus forced speaker) and opens an echo loop.

`GlassesPcmRouting.decide(softap, enabled)` picks exactly one producer:

- **SoftAP** → `externalPcm`. The wearer's voice arrives as BLE LC3, decoded by the Bluetooth
  SDK on the phone and forwarded through `pushOutgoingPcm`. The WHIP peer publishes video
  only. `externalPcmEnabled` is also a drop gate: without it, a host pushing PCM at a call
  that is taking relay audio would put the same room on the call twice.
- **Cloudflare WHEP** → `relayPcm`. The voice is already mixed into the subscribed track.
- **Phone** → `PhoneMicCapturer` (AudioRecord) into the same raw stream.

`ActiveStreamKind` reads `NONE` for a stream that is attached but not `STARTED`. "Attached"
is not "live", and treating it as live is how a muted wearer ends up audible.

### The chain

```
source PCM ─▶ AudioUplinkChain.ingest ─▶ DelayLine ─▶ PcmBridge ─▶ UplinkPacer
                                                                        │
                                       UplinkSender (20 ms deadline) ◀──┘
                                                │
                                       AcsUplinkTransport ─▶ RawOutgoingAudioStream
```

**`AudioUplinkChain`** puts ingest, delay, resample and pacing behind one lock so mute means
the same thing at every stage.

**`DelayLine`** holds input until it is `delayMs` old, in front of the resampler so the delay
is expressed in the input's own arrival times — which is what a receiver-side A/V measurement
calibrates against. `MediaDiagnostics.acsAudioDelayMs` ships at **0**, and 0 is not a
placeholder: how far BLE audio leads SoftAP video is a receiver-side measurement, not
something either side can infer. The host passes `audioDelayMs: 170` for SoftAP + LC3 calls,
derived from the clap correlator (leads of 70/201/173/300/142 ms, median 173).

**`PcmBridge`** downmixes and resamples to 48 kHz mono and re-chunks into the 20 ms frames
ACS expects. The resampler is stateful — filter history and fractional phase carry across
WebRTC's 10 ms callbacks, so there is no seam every 480 samples.

**`UplinkPacer`** is a clock-domain adapter, not a FIFO. The producer runs on the glasses'
audio clock and the consumer on the phone's monotonic clock; those never agree exactly, so a
plain queue drained by a 20 ms timer walks to empty or to the cap over a long call even with
no jitter. It locks depth to a target instead:

| Constant | Value | Role |
|---|---|---|
| `FRAME_MS` | 20 | One ACS frame |
| `TARGET_MS` | 60 | Default headroom |
| `LC3_TARGET_MS` | 160 | SoftAP glasses audio; device traces show 90–130 ms BLE gaps |
| `LOW_MS` / `HIGH_MS` | 40 / 100 | Sustained-error thresholds |
| `EMERGENCY_CAP_MS` | 400 | Shears only the peak. 200 punched a hole every time the delay line released a burst |
| `CORRECTION_MS` | 10 | Slice dropped or inserted per correction |
| `CORRECTION_INTERVAL_MS` | 500 | Rate limit, over a ~2 s EMA, so jitter never triggers one |
| `STARVE_MS` | 200 | Silence before declaring `STARVED` and rebuilding headroom |

`tick` always returns exactly one frame — real audio when the state machine allows, otherwise
manufactured silence to keep the ACS cadence unbroken.

**`UplinkSender`** drains it on a monotonic deadline thread (`acs-uplink-pacer`,
`MAX_PRIORITY`, one frame per wake). A fixed-rate executor is deliberately not used: after a
GC pause it is allowed to replay missed periods back to back, recreating exactly the
burstiness the pacer exists to remove. A whole period lost re-bases on now, so frames ACS
already missed stay missed and are counted as `skippedTicks`.

`AcsUplinkTransport` allocates fresh direct storage per submission — `sendRawAudioBuffer` is
asynchronous, so a reused buffer could be overwritten mid-send — and stamps the same 100 ns
tick base the video uses. Whether ACS honours those ticks for lip-sync on *raw* audio is an
open question; `MediaDiagnostics.acsAudioTimestamps` exists so it can be measured both ways
on the same device.

### Applying the policy

`AudioPolicyApplier` computes a decision, applies only what changed, and then **verifies**.
If the active stream is not what was expected it arms convergence retries at
50/100/200/400/800/1600 ms, each forcing a re-apply, because ACS state changes are
asynchronous and the first read after a mute is frequently stale.

It reports an `AudioSafety`:

- **`safe`** — the active stream is the expected one, or a failed mute was successfully
  escalated to `stopAudio`.
- **`degraded`** — an unmute failed, or the stream never converged. Held silent.
- **`unsafe`** — mute **and** stop both failed. A live microphone may be reaching the meeting.
  It is logged at error level and surfaced all the way to JS as `audioSafety`.

## Audio downlink path

Return audio deliberately does **not** use ACS playback.

```
ACS RawIncomingAudioStream ─▶ IncomingAudioPump ─▶ base64 ─▶ onIncomingPcm
   ─▶ AcsMeetingService.writeIncomingPcm ─▶ AudioPlaybackService ─▶ PcmStreamPlayer ─▶ A2DP
```

Playing it ourselves is what lets it reach the glasses over A2DP and participate in MCU
duplex via `setOwnAppAudioPlaying`.

`IncomingAudioPump` normalizes to **16 kHz mono regardless of what ACS actually delivers**.
The requested `RawIncomingAudioStreamProperties` are a hint; the event carries the real
format, and playing 48 kHz data on a 16 kHz `AudioTrack` is exactly the "slow and
low-pitched" symptom. It pre-rolls `DEFAULT_PREROLL_MS` (160 ms) then emits 60 ms batches, so
the player keeps headroom over bridge jitter instead of underrunning between 20 ms callbacks.

That preroll is the only knob for downlink latency and is not simply "more is better": the
remote path already stacks network, ACS receive, bridge batching, this preroll and A2DP
buffering, and every millisecond is conversational delay. Walk `PREROLL_LADDER_MS`
(120 / 160 / 200) on real hardware and ship the smallest value with no audible underruns.

`IncomingRateProbe` measures the callback rate and the real sample rate against the declared
one, and prints `P8 audio-in`.

## Networking on Android

This is the part with no iOS analogue and the most device-specific behaviour.

**`ScopedSoftApNetwork`** requests the glasses hotspot as a specific, internet-less network
and keeps the handle. Joining it takes the phone off its normal Wi-Fi, which is why the order
around it matters so much.

**`ScopedNetworkChangeDetector`** is installed at module create, before any
`PeerConnectionFactory`. Without it libwebrtc's `BasicNetworkManager` never sees the hotspot
and the phone's WHIP answer has no host candidate.

**`InternetHold`** is three distinct things that are easy to conflate:

- `awaitValidatedCellular()` — ask Android to bring cellular up and confirm it validated.
  `joinScopedNetwork` refuses with `SOFTAP_NO_CELLULAR_INTERNET` if it does not, because a
  phone whose mobile data cannot carry TLS strands the ACS join for its whole timeout with
  device-wide DNS failures, which reads as a hotspot problem and is not one.
- `bindProcessToCellular()` / `unbindProcess()` — the process-wide route pin.
- `awaitValidatedDefault()` — when this app's *default route* actually switched. Holding a
  cellular request does not answer that, and only this is a valid precondition for a join
  that must reach the internet.

**The pin has one exception, and it is subtle.** A `ServerSocket` bound to 192.168.43.x while
the UID is marked cellular accepts the bind but never sees the glasses' SYN — ICMP and ARP
still work, TCP to the listener times out. So `withIngestUnpinned` lifts the pin across
exactly the WHIP bind and restores it in a `finally`. Both `join` and `rebindSoftApIngest`
go through it.

**Ownership of the pin is not the scoped join's.** `leaveScopedNetwork` drops only the
hotspot bind. Releasing the pin there is what turned Cancel-during-hotspot into
`Request failed (503)`: the AP was still up, Android made it the default Wi-Fi, and the next
Teams create had no internet. The pin is dropped by `leave` / `leaveAndAwait` via
`releaseWhenDefaultInternetReady()`, and only once a validated default route exists.

Two device-specific behaviours are handled explicitly in `joinScopedNetwork`:

- `WifiDisabled` — the radio went off inside the join. `setWifiEnabled` has been a no-op for
  non-privileged apps since Android 10, so the only honest move is to fail by name. The panel
  this replaced held the call up to 90 s behind a system sheet, and the network the user then
  picked often became a default route with no internet.
- `Unavailable` — the first specifier steals `wlan0` from the phone's current Wi-Fi, Samsung
  assoc-rejects the glasses SoftAP (status 1025), and the request dies. After a settle delay
  the same join from an idle STA succeeds, so it is retried once.

**`SoftApSdpGuard`** inspects the glasses' offer against the scoped prefix and rejects one
whose candidates would leave the hotspot. `WhipIngestServer` binds to the phone's hotspot
address rather than the wildcard, which is what confines the endpoint to that interface.

**The 410 tombstone.** `stop()` leaves the listener answering `410` for a few seconds so an
in-flight POST from the glasses gets a status it can act on rather than a connection reset.
That grace is invisible from JS and a new Start inside it fails on a port this process still
holds — hence `awaitIngestClosed` and `forceCloseIngest`. A `closed: false` means the host
must force the close, not that it may carry on.

## State model

### Call phase

`idle → connecting → lobby → connected → disconnected`, plus `error`.

`pushCallState` maps ACS `CallState` onto those. `DISCONNECTING` deliberately holds the
current phase, because it may not yet carry a final reason. A `DISCONNECTED` with a non-zero
end code becomes `error` with `ACS_CONNECTION_LOST`; a zero code is an ordinary hang-up. Once
`lastError` is set, late ACS callbacks are ignored so they cannot overwrite it.

The transition into `connected` is where media statistics, diagnostics and capabilities are
attached and the audio policy is applied.

### Media source

Reported alongside the phase so the host can tell "call is up, glasses feed dead" from a
healthy call.

| From | To | On |
|---|---|---|
| `IDLE` | `CONNECTING` | `start` — listener bound, or WHEP offer posted |
| `CONNECTING` | `LIVE` | `first_frame` — a decoded frame reached the sink |
| `CONNECTING` | `FAILED` | `no_first_frame` — deadline expired, or negotiation failed |
| `LIVE` | `CONNECTING` | ICE bounced; the gate re-arms rather than claiming `LIVE` |
| `LIVE` / `CONNECTING` | `FAILED` | ICE failed, or the endpoint went away |
| `FAILED` | `CONNECTING` | a rebuild started (WHEP backoff, or an orchestrated SoftAP rebind) |

**`LIVE` means a frame reached the sink, not that negotiation succeeded.** The WHEP answer
lands before `setRemoteDescription`, before ICE CHECKING and before the first decode — on an
S22 reconnect, 3.2 s before the first frame and 6.2 s before a real rate to Teams. Promoting
on the answer had two consequences: a miniapp reading `live` was ahead of Teams, and a
subscription that answered but never delivered read `LIVE` forever behind a frozen frame.

So the answer arms `FirstFrameGate` and stays `CONNECTING`. The first frame for that peer
generation promotes (`first_frame`); no frame inside the deadline means `FAILED` with reason
`no_first_frame`. An ICE bounce back to CONNECTED returns to `CONNECTING` and re-arms rather
than claiming `LIVE` — a recovered candidate pair is a promise of frames, and if media was
already flowing the next frame promotes within milliseconds.

`SourceReusePolicy` allows a same-URL WHEP restart during `CONNECTING` to be a no-op:
rebuilding a subscriber seconds from its first frame only restarts the wait, and `CONNECTING`
is bounded by both the POST timeout and the first-frame deadline, so nothing can strand
there. SoftAP never reuses.

### Audio safety and capabilities

`audioSafety` is `safe | degraded | unsafe` as described above. `capabilities.hangUpForEveryone`
carries a **nullable** `allowed`, because "denied" and "not known yet" are different facts:
a denied End must be hidden, while an unknown one is what every call looks like between
joining and the first capabilities event.

## Recovery

Media and the ACS call fail independently. The call can stay `connected` with Teams holding
the last frame while the glasses feed is dead.

**WHEP** — `scheduleMediaRestart` rebuilds the subscription with exponential backoff
(`MEDIA_RESTART_BASE_MS` 1 s, shifted per attempt, capped at 10 s) for as long as the call is
alive. Native owns this first line because nothing above it can see ICE fail. A host
`updateVideoSource` with a new URL cancels the retry. `restartVideoSource()` forces a rebuild
even when the peer looks healthy; the host calls it from a NetInfo listener when the phone's
network identity changes.

**SoftAP — session-level rebuild is suppressed on purpose.** `forceRestart()` would rebind a
new OS-chosen port and mint a fresh `ingestUrl` that the glasses are never told about,
permanently stranding the call in `CONNECTING`. Instead the `FAILED` state is still surfaced,
the listener is left bound on its stable port so the glasses' own WHIP reconnect can recover
against the unchanged URL, and a network-level rebuild is the orchestrator's job.

That orchestrated recovery is `SoftapCallTransport.runRecover`: re-raise the hotspot, rejoin
the scoped network, `rebindSoftApIngest` (which force-closes the old generation and refuses a
null or unchanged URL), re-publish, and wait for a fresh first frame. **The ACS call is
preserved** — a lost hotspot is a media outage, not call termination. The wearer has
`RETURN_DEADLINE_MS` (60 s) to come back in range, with a `REARM_BUDGET_MS` (45 s) budget for
the rebuild. `MediaDiagnostics.SOFTAP_RECOVERY_ENABLED` is the kill switch.

## Threads and concurrency

| Thread | What runs on it |
|---|---|
| `AcsMeetingSession` single-thread scheduled executor | join, leave, audio policy, media source state, rebind |
| WebRTC decode | the video sink: scale, `toI420`, admit, copy |
| WebRTC audio | `AudioTrackSink` → uplink chain ingest |
| `acs-i420-send` | `sendRawVideoFrame` and nothing else |
| `acs-uplink-pacer` | drains `UplinkPacer` on a 20 ms deadline, `MAX_PRIORITY` |
| `acs-zc-release` | delayed zero-copy releases |
| `acs-synthetic-i420` | investigation arm only |
| main looper | the 1 Hz ticker and the WebRTC `getStats` poll |
| ACS SDK threads | state, format, roster, capability and media-statistics callbacks |

Three rules:

1. **Nothing blocking may run on the WebRTC decode thread.** A `PeerConnection.getStats()`
   call there once stalled video after roughly one second. The stats poll is now timer-driven
   on the main looper, which also means it keeps sampling during a freeze instead of going
   quiet exactly when the data is interesting.
2. **Every ACS callback hops to the session executor** before touching session state, so
   roster, format and diagnostic callbacks serialize with join and leave.
3. **Everything is serialized onto one executor**, so a `join` that appears to take 40 s may
   have spent 38 of them queued behind the previous call's `leaveLocked`. `traceQueued`
   records `queuedMs` for exactly this, because a slow ACS and a blocked queue have opposite
   fixes.

## Generations and stale callbacks

Three independent counters fence work that can outlive what started it:

- **`joinGeneration`** (session) — bumped by every join and leave. A bounded ACS operation
  that completes late finds a stale generation instead of attaching to a session that has
  moved on.
- **Peer generation** (media source) — a frame or a deadline belonging to a peer being torn
  down can neither promote nor fail its replacement.
- **`callGeneration`** (`AcsMeetingService`, JS) — captured by the `onState` subscription,
  the `mic_pcm` listener and the in-flight `native.join`, so a leave during a slow join cannot
  resolve into a torn-down host.

`AbandonedCallAgent` handles the related problem on the ACS side. `createCallAgent` has no
timeout of its own and on device stalled 30 s while cellular was still validating. Cancelling
the Future drops the only Java handle, and the next join then dies with "an instance of
CallAgent associated with this identity already exists". So the code never cancels: it takes
the completed value later (sweeping for `LATE_AGENT_SWEEP_MS` × `LATE_AGENT_SWEEPS`) and
disposes it, and a rejoin waits `ABANDONED_AGENT_REJOIN_WAIT_MS` for the leftover sign-in to
finish so it can be cleaned up.

## Investigation arms

All in `MediaDiagnostics` (`glasses-media/source/VideoSourceArm.kt`). **Flip locally, rebuild
native, do not commit a flipped value.**

| Flag | Ships as | The other arm |
|---|---|---|
| `videoArm` | `WHEP` | `SYNTHETIC` bypasses glasses, transport and decode entirely |
| `decoderMode` | `TEXTURE` | `BYTE_BUFFER` skips the GL readback. Did not clear the gates |
| `zeroCopy` | `false` | Retain tight WebRTC planes, with an automatic copy fallback |
| `pixelFormat` | `I420` | `NV12` is the encoder-flip A/B. Keep only if `codec=` leaves `h264_sw` |
| `outgoingRate` | `ADVERTISE_REQUESTED` | `CLAMP_TO_SOFTWARE_CEILING` pins fps to 8 |
| `acsAudioTimestamps` | `true` | Off, so the lip-sync question can be asked both ways |
| `acsAudioDelayMs` | `0` | Host passes 170 for SoftAP + LC3 |
| `LIBWEBRTC_VERBOSE` | `true` | Turn off once SoftAP is green on device |
| `SOFTAP_RECOVERY_ENABLED` | `true` | Freezes ingest rebind without a rebuild |

`outgoingRate` is worth reading in full. `CLAMP_TO_SOFTWARE_CEILING` was the default on the
strength of soaks reporting `codecName: "h264 sw"` alongside wire ≈ 8.8 fps, read as an
encoder ceiling. Two things in the device logs say it was never the encoder: 720p15 and
540p15 both reported ~8.8 fps, and 540p is 52% of the pixels — a CPU-bound encoder would have
been nearly twice as fast at the smaller size, so a limit that does not move with pixel count
is not a pixel cost. And once `FramePacer` delivered a steady cadence, `wire` tracked what we
handed ACS (6.9 against 7.1 admitted), which is an encoder keeping up. Both soaks ran through
a send path that could not hold a rate, so what they measured was our own delivery.

## Telemetry

Everything logs under the tag `ACS-SPIKE`. SoftAP sequencing additionally emits
`SOFTAP_TRACE` stage/failure lines sharing one trace id across JS and native.

```bash
adb logcat -s ACS-SPIKE
adb logcat -s ACS-SPIKE | grep "P6 ladder"
```

| Line | What it is |
|---|---|
| `P3 attach` / `factory` / `rotation` | Transport: track attachment, WebRTC factory, non-zero rotation |
| `P4 pcm` / `wrote` | Outgoing PCM level (`meanAbs`, `peak`), and the WAV dump |
| `P5 negotiated` / `send-enter` / `send-exit` | ACS video format, and per-send tracing for the first 8 frames |
| `P6 ladder` | The 1 Hz frame ladder |
| `P6 wire` | ACS `MEDIA_STATISTICS` as they arrive |
| `P7 rate` | Verdict: what is actually binding the wire rate |
| `P7 diag` / `diagnostics` | ACS call diagnostics (network quality, reconnect, relays) |
| `P8 audio-up` / `audio-in` | Uplink pacer and sender state, and the measured incoming rate |
| `P9 quality` | Bits-per-pixel band for the wire |
| `AVSYNC live` / `clap` | Live A/V skew, and the clap correlator |

### The P6 ladder

One line per second, tracing a frame through every hop:

```
P6 ladder arm=whep 1280x720 recv=14.8 dec=8.1 sink=8.0 dup=4 sub=8.0 wire=1280x720@8.0 kbps=1400 codec=h264_sw rot=0
  drop{size=0 busy=0 notStarted=0 fail=0 nullI420=0 pace=6 abandoned=0}
  recv{drop=6 lost=0 nack=0 pli=0 freeze=2 freezeSec=3.4 jit=4.0 decMs=3.2 jbMs=210.0 decImpl=c2.qti.avc.decoder}
  path{mode=texture copy=planes pix=i420} buf{tex=12 i420=0 other=0}
  stride{y=1280 u=768 v=768 tight=0 padded=12} zc{on=0 used=0 fell=0 padded=0 heldMax=0 timeout=0}
  ms{gapP50=68.3 gapP95=523.4 i420P95=12.0 packP95=na scaleP95=na sinkCbP95=20.0 splitP95=na copyP95=4.1 queueP95=0.6 sendP95=2.7}
  lat{ageP50=41.0 ageP95=88.0 e2eP50=63.0 e2eP95=120.0 slowest=i420}
  alloc{dest=0 plane=3} chroma{y=162 u=132 v=132} cum{sink=1000 sub=1000 drop=0 inFlight=0}
  cpu{proc=112.4 cores=8}
```

The rates form a ladder, and **the first place two adjacent numbers diverge is the
bottleneck**:

| Field | Hop |
|---|---|
| `recv` | Frames WebRTC pulled off the wire (`framesReceived`) |
| `dec` | Frames the decoder produced (`framesDecoded`) |
| `sink` | Frames our `VideoSink` saw |
| `sub` | Frames submitted to ACS |
| `wire` | Frames ACS actually encoded (`Features.MEDIA_STATISTICS`) |

`recv` well under the target blames the network or Cloudflare; a healthy `recv` with a low
`dec` blames the decoder or jitter buffer; `sink` below `dec` means frames are dropped before
us; `sub` below `sink` means we dropped them, and `drop{}` names which reason.

The rest:

- **`cum{}`** is monotonic and is what pass/fail uses. `inFlight` is *derived* as
  `sink - sub - drop`, which makes conservation an identity — a tracked counter cannot be read
  atomically alongside the others and produced false `CONSERVE_FAIL` alarms on a healthy
  pipeline.
- **`ms{}`** is our own cost. At 15 fps the budget is 66 ms. `i420P95` is `toI420()` (GL
  readback on `texture`, libyuv on `bytebuf`), `copyP95` the plane copy into ACS buffers,
  `queueP95` the wait on the send executor, `sinkCbP95` the whole decode-thread callback.
  `packP95`/`splitP95` stay in the line for old captures and print `na`.
- **`lat{}`** is age at the sink and end-to-end to submission, plus which stage is slowest.
- **`path{}` / `buf{}` / `stride{}` / `zc{}`** say which arm produced the line. `buf.tex`
  climbing with `mode=texture` is the Surface decoder; `buf.i420` climbing with `mode=bytebuf`
  is the A/B working. `pix=nv12` plus `copy=nv12` is the encoder-flip arm. `stride.padded`
  dominating means zero-copy will fall back. `decImpl` turning into a software name
  (`c2.android`, `c2.google`, `OMX.google`) is an abort for the byte-buffer arm.
- **`chroma{}`** should sit near `u≈v≈128` on neutral content. Pinned at 0 or 255 means the
  planes are mis-packed — the signature of a stride or geometry bug.
- **`dup`** counts refused duplicate track attachments. WebRTC delivers one track through
  three observer callbacks as three distinct Java wrappers, so object identity cannot dedupe
  them and `TrackRegistry` keys on `track.id()`. Steady `dup=4` (two video, two audio) is
  correct; climbing `dup` means sinks are being re-added.
- **`alloc{}`** should stay flat after the first frames if pooling holds.
- **`cpu{proc}`** is process CPU% the way `top` reports it and can exceed 100 on multi-core.
  High `i420`/`sinkCb` with high `proc` supports convert-on-decode-thread; high `sendP95` with
  low `i420` blames ACS encode/submit. Preview is JS/UI and is not in this line.

### P7 rate

The ladder says what happened; this says what is binding, and the two want opposite fixes.

| `bound=` | Meaning |
|---|---|
| `OK` | Wire is holding the advertised rate |
| `SOURCE_SHORT` | The glasses/WHIP leg is short; raising ACS fps cannot help |
| `PACER_SHORT` | Our own gate is dropping frames the source supplied; check `FramePacer` |
| `ENCODER_SHORT` | ACS encoder is the ceiling; cut pixels, not fps |
| `BITRATE_STARVED` | Rate controller is throttling, not CPU; do not cut fps or pixels |
| `CAP_BOUND` | Riding the granted ceiling; raising `maxBitrateBps` is the only lever |
| `UNKNOWN` | Not enough evidence yet |

Every input is printed beside the verdict, because a verdict whose inputs are invisible is
the same guess this class replaces.

### Call diagnostics and wire episodes

`CallDiagnostics` samples densely (2 s) while a call settles and sparsely (10 s) after, but
**a dip or a downscale re-opens the dense window** for `RECOVERY_WATCH_MS`. The old cadence
was dense for 90 s and sparse forever after, on the assumption that a call which settles low
does so early; an 8-minute capture disproved it — the collapse began at t=150 s, so the
interesting 90 s got nine points while the uneventful first minute got forty-five.

`WireEpisodeTracker` names each stretch where the uplink went bad, because the failure that
matters is an interval, not a number. The motivating capture sat at ~1.3 Mbps, fell to
33 kbps and 320×180 at t=150 s, stayed ~90 s, then took ~170 s to climb back — while the
glasses hop held ~2 Mbps throughout. No single sample says that, and a mean over the call
says the opposite.

The rule that is easy to get wrong: **a missing rate is not a low rate.** ACS publishes
MEDIA_STATISTICS reports with fields unset (32 empty against 12 filled across one
seven-minute call), and treating those as zero would invent an episode for every silence and
bury the real ones. Silence leaves the state machine where it was.

Both are marked `TEMPORARY DIAGNOSTIC` and pair with `scripts/acs-quality-compare.mjs`. Their
thresholds are duplicated in that script on purpose — native decides when to look harder, the
analyzer decides how to score, and neither should silently inherit the other's number. If one
moves, move both.

## A/B captures on record

Capture with preview off, ~90 s of steady motion, the same room, after a 20 s warmup:

```bash
adb logcat -c
# join the Teams call, hold steady motion
adb logcat -d -s ACS-SPIKE > /tmp/acs-<arm>.txt
```

Compare on **medians**, not the last tick. A 15% `recv` gap or a 2× packet-loss gap is a
confound: the network differed and any CPU delta is not attributable. Capture baseline first
(texture + planes, `zeroCopy=false`, `pixelFormat=I420`), then one flag at a time.

Confirm the join logs before saving each dump:

- glasses WHIP: `whip start (1280x720@15)` or `whip start (960x540@15)`
- miniapp handoff: `requestedAcs=1280×720 @15` or `requestedAcs=960×540 @15`
- native: `P5 negotiated ... 1280x720 fps=15` or `... 960x540 fps=15`
- ladder: `wire=1280x720@...` or `wire=960x540@...`

**720p15 vs 540p15, both TEXTURE.** `SM_S906U`, 2026-09-01, medians. `recv` matched, but
`lost` went 39 → 7, so the CPU delta is **not** attributable. Wire fps is.

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

Same ~1.4 Mbps, ~9 → ~13 fps. Keep 540p15 selectable; it is not the default.

**BYTE_BUFFER.** Recorded on `SM_S948U` at 720p15 — wrong profile against the plan, and a
different SoC from the arms above. Mechanical decode passed (`i420P95=0.0`, hardware decoder,
`recv/dec/sink` all 15) but the campaign gates did not: no wire fps, no `codec=`, and
`drop.busy` climbing. `decoderMode` stays `TEXTURE`.

Promote BYTE_BUFFER only when **every** gate passes:

- `path{mode=bytebuf}`, `buf{i420}` rises, `buf{tex}=0`
- `recv` differs by at most 15% and packet loss by at most 2× (else confounded)
- `decImpl` stays hardware (`OMX.qcom`, `c2.qti`, vendor)
- median process CPU improves by at least 8 percentage points, `i420P95`/`sinkCbP95` improve,
  and `wire` does not regress by more than 5%
- no malformed frames, busy/fail drops, chroma corruption or remote freezes

If it fails, revert only `decoderMode`. Switching Glasses video back to `720p · 15 fps` is
the separate profile rollback and takes effect on the next join.

## Tests

```bash
./scripts/check-android-compile.sh bluetooth-sdk \
  :mentra-acs-meeting:testDebugUnitTest \
  :mentra-glasses-media:testDebugUnitTest

swift test --package-path mobile/modules/acs-meeting/ios/PolicyKit
swift test --package-path mobile/modules/glasses-media/ios/CoreKit
```

These are plain JVM tests with no Robolectric, which constrains what can be tested: ACS SDK
types like `VideoStreamFormat` are native-backed and throw `ExceptionInInitializerError`
outside an Android runtime. The pattern throughout is to keep the logic worth asserting in a
pure class and let the thin SDK-facing wrapper go untested — `I420FormatSpec` holds the stride
arithmetic while `AcsFrameSender.i420Format` just copies it onto the SDK object. Same reason
`AcsAudioPolicy`, `FramePacer`, `UplinkPacer`, `WireEpisodeTracker` and `FirstFrameGate` are
dependency-free.

Anything concurrent has a test that actually races it: `SendGateTest` contends the gate,
`RingPercentileTest` writes from multiple threads, and `PipelineStatsTest` reproduces the
counter race that caused the false conservation failures.

## iOS

Same contract, fewer knobs. `AcsMeetingModule.swift` exposes the same Expo surface;
`WhepVideoSource` and `LocalWhipIngestSource.swift` deliver `CVPixelBuffer`;
`AcsFrameSender.swift` sends on the virtual stream behind a `VideoSendGate` with a simple fps
throttle. `GlassesHotspotNetwork` uses the same persistent `NEHotspotConfiguration` join as
gallery transfers, verifies the joined SSID and `en0` address, and waits for DHCP against the
gateway the glasses advertised before resolving. Audio policy logic is shared through the
`PolicyKit` Swift package.

Screen-off and background operation already work in the Mentra App through its existing
Bluetooth background modes, and bulk gallery transfers over SoftAP already run in the
background. Treat those as established; what needs device validation is this media pipeline
on top of them.

Differences from Android today: no `RemoteRoster` (`participants` is never emitted), no
telemetry ladder, and `maxBitrateBps` is not applied to the outgoing stream.

## Known gaps

- **Glasses encoder stats are never reported.** The `encoder-stats` event arrives with
  `reported: false`, so the top of the ladder (`src`) stays dark and we cannot yet confirm the
  glasses are producing the requested rate.
- **iOS media qualification needs device coverage** — sustained local WebRTC reception, ACS
  publishing, thermal behaviour and screen-off operation on the new pipeline.
- **iOS lacks the roster, the ladder and the bitrate cap** (above).
- **Raw-audio lip-sync is unverified.** We stamp outgoing audio with 100 ns ticks, but whether
  ACS honours them for raw audio needs a receiver-side Teams recording with
  `acsAudioTimestamps` on and off.
- **Downlink preroll is not yet tuned on hardware.** 160 ms is one step up from a 120 ms that
  underran, not a measured optimum; walk `PREROLL_LADDER_MS`.

The original spike runbook is preserved at [spike/README.md](spike/README.md). The shared
transport library is documented in [`glasses-media`](../glasses-media/README.md).
