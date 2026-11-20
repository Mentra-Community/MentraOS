# Glasses media transport

Native receivers, WHIP publishers and network helpers shared by the Mentra App. This library has no ACS SDK dependency. ACS consumes decoded media for calls; managed WebRTC streams feed the same decoded video and PCM to `PhoneWhipPublisher`.

- Android: the existing `GlassesMediaSource`, local WHIP and WHEP receivers, scoped SoftAP networking, decoded I420/PCM delivery, and transport diagnostics moved here. The ACS session and raw outgoing streams remain in `acs-meeting`.
- iOS: `DecodedGlassesMediaSource` delivers `CVPixelBuffer` video and interleaved PCM16. `LocalWhipIngestSource` answers the glasses' existing WHIP client; `WhepVideoSource` retains the cloud subscription path.
- `GlassesHotspotNetwork` owns hotspot association for OTA, gallery transfers and media. iPhone uses persistent `NEHotspotConfiguration`, and keeps only the one it is joining: every join first removes the app's configurations for other hotspots, and each launch removes leftovers, so a phone near many pairs never rejoins another pair by itself; iOS-on-Mac uses CoreWLAN in the app process (its channel-scoped scan and forget call are not public) and the standard Location permission needed to identify Wi-Fi networks. Wi-Fi carries the glasses link; cellular carries the call. The owner verifies the requested SSID and actual Wi-Fi interface address, retains that interface for loss checks and ACS binding, and serializes network writers across consumers. Cancellation retains custody until blocking native work and cleanup finish. Cleanup preserves a network the user joined afterward; a failed release rejects and retains ownership for a later cleanup attempt.

The publisher owns its outgoing encoders, audio policy, and destination. Receivers do not open the phone microphone or play the glasses microphone locally. iOS uses a receive-only audio device to drive decoded PCM delivery without changing the app's audio session.

## Lifecycle

The host signs in, enables the glasses hotspot, joins it, prepares the receiver and publisher, then tells the glasses to publish to the returned `ingestUrl`. A successful listener bind is not a live stream: `live` requires a decoded video frame. iOS waits for full ICE gathering and returns only actual host candidates on the hotspot interface. Requests and queued media are bounded.

Stop the glasses publisher before stopping the receiver and releasing the network. Await `LocalWhipIngestSource.stop(completion:)` before reusing resources on iOS. Android owners discarding a receiver use `close()` to drain HTTP negotiation and release its retained factory and EGL resources. It cancels pending offers, closes the peer and HTTP listener, and drains teardown before completing. A local source must not silently restart onto a new port; the host must coordinate any new URL with the glasses. WHEP can rebuild its existing URL.

## Verification

```sh
swift test --package-path mobile/modules/glasses-media/ios/CoreKit
swift test --package-path mobile/modules/acs-meeting/ios/PolicyKit
./scripts/check-android-compile.sh bluetooth-sdk :mentra-glasses-media:testDebugUnitTest :mentra-acs-meeting:testDebugUnitTest
```

After iOS prebuild and `pod install`, compile the actual shared-library consumer:

```sh
xcodebuild -project mobile/ios/Pods/Pods.xcodeproj -target AcsMeeting \
  -configuration Debug -sdk iphonesimulator -arch arm64 \
  ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
```

Before merging/releasing, exercise iPhone + glasses: first-use local-network permission and hotspot prompts; join/admit/mute/leave; music/camera sounds; rapid Start/Cancel/Start during sign-in, hotspot join, and WHIP negotiation; hotspot loss; repeated joins; screen-off/background streaming; and a sustained call while measuring latency, audio/video alignment, and thermal behavior. Screen-off operation and background gallery transfers already exist in the Mentra App; these checks qualify the new media pipeline. A simulator build and loopback HTTP tests cannot establish physical Wi-Fi/cellular routing or camera behavior.

## Managed WebRTC relay

`PhoneStreamCoordinator` provisions Cloudflare and owns subscribers for the entire route:

```text
Glasses -- video-only WHIP over SoftAP --> shared receiver --> phone WHIP publisher --> Cloudflare
Glasses MCU -- BLE LC3 --> phone PCM decoder ----------------------^
```

Only `ingest: "whip"` selects this route. Default SRT and explicit RTMP continue publishing directly from the glasses. WHIP never falls back to SRT/RTMP when Cloudflare omits its WHIP URL. The phone needs mobile data; the glasses need no internet Wi-Fi credentials. Livestreamer's Stream Here path skips its glasses Wi-Fi setup gate accordingly.

`MentraGlassesMediaRelay.prepare` joins the persistent hotspot, prepares both native peers, and returns a local WHIP URL for the BLE start command. Cloudflare credentials stay on the phone. Video queues hold at most one frame; decoded PCM is downmixed/resampled into a bounded 200ms, 48kHz mono queue. Unless the caller asks for video passthrough (below), WebRTC re-encodes both tracks. No phone microphone is captured. Android uses the WebRTC library's external AudioRecord buffer mode; iOS uses a custom `RTCAudioDevice`.

### Video passthrough (Android)

`startStream({ingest: "whip", videoPassthrough: true})` has the phone forward the glasses' H.264 as it arrives instead of decoding it and encoding it again. The host advertises support as `hostFeatures.videoPassthrough`; a caller can pass the option without checking, and the iOS relay ignores it.

```text
Glasses -- H.264 over WHIP --> receiver (decoder that does not decode) --> publisher (encoder that does not encode) --> Cloudflare
```

libwebrtc only moves decoded pictures between a receiver and a sender, so `passthrough/` smuggles the encoded bytes inside a `VideoFrame.Buffer`. `PassthroughH264Decoder` wraps each access unit in an `EncodedFrameBuffer`, `DecodedTrackRelay` hands it to the publisher without touching pixels, and `PassthroughH264Encoder` returns the same bytes as the encoded result, with the key/delta marking and timestamp kept.

What that changes:

- **The phone does no video work.** No decode, no scale, no encode: less CPU and heat, and one fewer generation of picture quality.
- **A key frame can only come from the glasses.** The relay cannot make one. After a loss on the hotspot leg (`DecodeInfo.isMissingFrames`), a full publisher queue, or the uplink asking for one, `PassthroughBridge` waits for a key frame: the decoder returns `ERROR` for delta frames, which makes libwebrtc ask the glasses for a key frame and stop feeding deltas. Forwarding a delta after a gap would hand Cloudflare an undecodable stream it could never see the gap in, because the outgoing RTP is rebuilt here.
- **Frames queue in order and are not thinned.** The publisher holds up to 15 encoded frames. Past that it drops them all and waits for a key frame, instead of dropping single frames as the decoded path does.
- **The bitrate and picture size are the glasses'.** The encoder records the rate the uplink would allow (`uplinkTargetBps`, logged every 10 s) but cannot follow it, and degradation and scaling are turned off. A cellular uplink below the glasses' bitrate queues and delays instead of adapting. A BLE bitrate command would close that gap and does not exist yet.
- **No photo from the stream.** `StreamFrameGrab` needs pixels, so a photo taken during a passthrough stream is answered as it is for any stream the phone does not decode (`CAMERA_BUSY`).
- **Audio is unchanged.** BLE LC3 to PCM to Opus, as above.

The route is chosen when the relay is prepared and fixed for that stream. Teams and ACS calls, which need decoded frames, keep the real decoder. The log shows `video=passthrough` or `video=reencode` on the `ManagedRelay` audio-transport line, and `passthrough in=… out=… dropped=… keyRequests=…` every 10 s.

On Android hosts with microphone pinning and native PCM input, managed streams use the same BLE LC3 capture path as ACS SoftAP calls. An engine-owned `livestream` microphone session requests continuous glasses PCM; it leaves the configured gain in force and disables the call-specific loudness gate. The glasses receive `captureAudio: false`, avoiding SoC microphone capture and audio encoding, while the phone publishes video plus LC3-derived audio to Cloudflare. Attempt-scoped callbacks and native PCM gating reject late audio after stop/retry. Explicit `captureAudio: false` disables audio entirely. iOS and older hosts retain WHIP audio, matching ACS capability gating. ACS's measured 170ms audio delay is specific to its outgoing pipeline and is not applied to the Cloudflare publisher without calibration.

Android's process-wide network inventory exposes both the scoped hotspot and real cellular handles during a relay. Per-factory masks keep the receiver on Wi-Fi and the publisher off Wi-Fi; signaling also uses the cellular network's socket factory and DNS. ACS retains its existing hotspot-only inventory. iOS uses corresponding per-factory masks after validating the cellular default route.

The iOS internet publisher posts its offer on the first server-reflexive candidate, complete ICE gathering, or a 1.5-second gather deadline, matching the glasses publisher's STUN policy. It posts once and ignores late triggers after stop. The local SoftAP receiver still waits for complete host-only gathering. Incident logs record the outgoing negotiation stage, candidate counts, HTTP result and first decoded video frame without SDP or publish credentials.

Android temporarily lifts the cellular process pin while creating the local WHIP listener, then restores it before starting the outgoing publisher. Otherwise the listener inherits the cellular socket mark and cannot reply to the glasses. The outgoing audio callback supplies its own PCM frame clock: WebRTC's external-recording mode does not pace callbacks and reports zero captured bytes, so the callback fills the entire buffer and waits for the next frame interval without opening the phone microphone.

An attempt-specific ID isolates late callbacks and glasses status. Reconnect tears down the glasses publisher, both phone peers and hotspot before rebuilding against the same provisioned input. Three retries bound consecutive failures; a minute of stable streaming renews the retry budget. Last-subscriber stop cancels startup/backoff, awaits native cleanup and disables the hotspot. Failed cleanup retains ownership and can be retried by stop. BLE-unreachable stop/hotspot commands are deferred until reconnection. OTA, Gallery, ACS and managed streaming share one hotspot reservation before BLE AP changes or native association. OTA, Gallery and managed relay retain it until their owned cleanup completes. ACS still has an older retirement policy that releases its JavaScript reservation after reporting an unconfirmed stop; native association custody remains retained on failure. Consolidating that ACS retirement is a separate qualification gate. A refused OTA or Gallery caller makes no AP or association changes. Native media queues keep running when the UI is backgrounded; Android holds a partial wake lock and uses the engine's background timers for retry/readiness.

Device qualification for this outgoing pipeline must include Android and iPhone: audio/video playback on the provisioned WHEP URL, mute/video-only capture, last-subscriber stop, cancellation at each setup step, cellular/hotspot/BLE loss and recovery, repeated starts, screen-off/background operation and a sustained thermal/audio-sync run. Unit tests and platform compilation cover lifecycle/format contracts; they do not establish those hardware results.

## Photos from a stream

The glasses camera cannot take a photo while it streams. `StreamFrameGrab` (Android `grab/`,
iOS `StreamFrameGrab.swift`) turns the next decoded frame of any stream this library receives
into a JPEG, so a miniapp's `takePhoto()` keeps working during an ACS call or a managed WebRTC
relay without pausing either.

- The tap is where every receiver hands over a decoded frame: `DecodedTrackRelay` on Android,
  before scaling, so the photo has the stream's resolution and not the size ACS negotiated down
  to; `LocalWhipIngestSource` and `WhepVideoSource` on iOS.
- Nothing is stored between photos. A request waits for the next frame, retains it, and encodes
  on its own thread. With no request waiting, a frame costs one volatile write and one volatile
  read on Android, and one uncontended lock on iOS.
- `streamFrameAgeMs()` is how the host knows a stream is passing through the phone at all. With
  no frame in the last second, the host sends the ordinary photo command, and glasses that are
  streaming some other way (SRT, RTMP) answer `CAMERA_BUSY`.
- Android applies the frame's rotation to the JPEG. iOS does not: its receivers drop rotation
  before the frame reaches this library, as the relay's own publisher does.

The host side is `PhonePhotoCoordinator` and `StreamFrameSource` in `@mentra/engine`. A caller
that paused the stream to take a full-size photo (Mentra Call's photo pause) is given the camera,
not a frame.

### Incoming OTA server and outgoing media clients

Hotspot association verifies the glasses SSID and the Wi-Fi interface/address for
both uses. Gallery and relay clients also wait for outgoing Local Network access
by connecting to the glasses HTTP endpoint. OTA selects `incoming-server`: it
serves already downloaded artifacts to connections initiated by the glasses, and
its own listener must become ready before the app sends the OTA manifest URL.
It does not depend on the Gallery HTTP server being available. Apple TN3179 lists
accepting incoming TCP as an operation that does not require Local Network
permission. This does not change outgoing Gallery/relay consent or the shared
network ownership and teardown rules.
