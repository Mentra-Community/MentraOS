# Local WHIP network regression

Run `mobile/modules/glasses-media/ios/Tests/LocalWhipNetwork/run.sh` on a Mac with
Xcode and an installed iOS Simulator runtime. The script downloads the exact
WebRTC SDK pinned by `GlassesMedia.podspec`, creates a temporary simulator, and
cleans it up. An existing booted simulator can be selected with
`WHIP_SIMULATOR_ID`; `WHIP_WEBRTC_XCFRAMEWORK` can point to a local SDK bundle.
`WHIP_TEST_INTERFACE` defaults to `en0` and must have a private IPv4 address.

The native sender gathers a valid local offer first. A test-only dynamic library
then makes Network.framework report that interface as cellular on subsequent
default-path updates. It does not modify the Mac's interfaces, routes, sockets,
or SDP. The production HTTP listener and receiver negotiate the offer.

Two separate processes run against the same SDK:

- The control compiles a temporary copy of `GlassesPeerFactory` with its
  NWPathMonitor field trial enabled. It must return HTTP 500 specifically because
  the **phone answer** has no hotspot candidate. This also verifies the injected
  network condition actually takes effect.
- The production factory must return HTTP 201 with a real candidate on the
  bound interface and complete receiver cleanup.

This covers the failure in report `rep_01M2C5JGKV8JF0VSFN3J22TQS3`: the glasses
could reach the phone and supplied valid SoftAP candidates, but the phone's
default internet path was cellular. WebRTC M137 installed its default-path
monitor unconditionally even with `disableNetworkMonitor = true`. M144 honors
the field trial for the custom-audio factories used by the receiver and relay.

The field-trial configuration is process-wide and is set once, rather than
toggled for individual peers. Later standard WebRTC factories also enumerate
interfaces; per-factory adapter masks and the receiver's SDP filter remain in
force. Both CocoaPods consumers must use the same SDK, so the LiveKit patch
changes only its iOS pod dependency. Its JavaScript and Android versions stay
the same.

This check covers candidate gathering and negotiation. Physical glasses,
cellular uplink, background operation, and media delivery need device testing.
