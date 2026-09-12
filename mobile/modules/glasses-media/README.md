# Glasses media transport

Native receivers and network helpers shared by media publishers. This library has no ACS SDK dependency. `acs-meeting` is its first consumer; a future Cloudflare publisher can consume the same decoded video and PCM without joining a meeting.

- Android: the existing `GlassesMediaSource`, local WHIP and WHEP receivers, scoped SoftAP networking, decoded I420/PCM delivery, and transport diagnostics moved here. The ACS session and raw outgoing streams remain in `acs-meeting`.
- iOS: `DecodedGlassesMediaSource` delivers `CVPixelBuffer` video and interleaved PCM16. `LocalWhipIngestSource` answers the glasses' existing WHIP client; `WhepVideoSource` retains the cloud subscription path.
- `GlassesHotspotNetwork` uses the same persistent `NEHotspotConfiguration` join as gallery transfers. Wi-Fi carries the glasses link; cellular carries the call. It verifies the joined SSID and `en0` address, reports network loss, and retains a cancelled join until the uncancellable system callback has been cleaned up.

The publisher owns its outgoing encoders, audio policy, and destination. Receivers do not open the phone microphone or play the glasses microphone locally. iOS uses a receive-only audio device to drive decoded PCM delivery without changing the app's audio session.

## Lifecycle

The host signs in, enables the glasses hotspot, joins it, prepares the receiver and publisher, then tells the glasses to publish to the returned `ingestUrl`. A successful listener bind is not a live stream: `live` requires a decoded video frame. iOS waits for full ICE gathering and returns only actual host candidates on the hotspot interface. Requests and queued media are bounded.

Stop the glasses publisher before stopping the receiver and releasing the network. Await `LocalWhipIngestSource.stop(completion:)` before reusing resources. It cancels pending offers, closes the peer and HTTP listener, and drains teardown before completing. A local source must not silently restart onto a new port; the host must coordinate any new URL with the glasses. WHEP can rebuild its existing URL.

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

Cloudflare publishing and changes to RTMP/SRT routes are outside this library extraction.
