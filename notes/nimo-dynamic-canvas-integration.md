# NIMO Dynamic Layout V1 integration

## What the handoff contains

The September 8, 2026 `mentra-android-20260908` handoff is a source patch for
NIMO glasses, not an APK or a firmware update. Its README identifies the baseline
as `e4156a951bbf1627f139325ad098f90828e93c3d` and the Android/shared snapshot as
`a6a50b0fc92ea6b6a0a3a9aba913af881e283e81`. All three files passed its supplied
SHA256SUMS checks before integration.

The patch replaces fixed text/map widgets with the vendor's 500×220 Dynamic
Layout V1 canvas. It includes positioned text, rectangles, compressed 2bpp
images, serialized Bluetooth writes and business acknowledgements, scene
restoration, Android navigation/location lifecycle fixes, and miniapp updates.
The original delivery explicitly excluded iOS.

This integration merges those changes onto `dev` and adds the corresponding
native Apple canvas encoder, image decoder, command state machine, CoreBluetooth
write queue, and scene/brightness/welcome handling. Existing immediate miniapp
CONNECT_ACK delivery and deferred dashboard cleanup on `dev` are preserved.
Android debug framebuffer diagnostics remain debug-only; they are not required
by the iOS implementation or production transport.

## Firmware and packaging

Use the vendor-supplied `537cf1` dynamic-v1 firmware. The handoff identifies its
stock OTA file by SHA256
`5e23c574e3dfd8c27172f4f9a33475e6efd0d33e7230bfcce8f4fe8ca59fe433`.
That is an artifact identifier, not an assertion about firmware installed on a
connected device. Earlier pre-canvas firmware is not compatible with this path.
This change does not distribute or install firmware.

Captions 1.0.18, Translation 1.0.21, Teleprompter 1.0.8, and Navigation 1.1.32 are
rebuilt from this checkout in production mode, then installed in
`mobile/assets/miniapps/` and included by the generated bundle manifest. Maps uses
the workspace's `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN`; the development token from the
handoff's prebuilt Maps archive is replaced. The separate Mapbox downloads
credential remains a build-time prerequisite for native Maps dependencies.

Apple dependencies are the system ImageIO and zlib libraries, declared in the
Bluetooth SDK podspec. Both platforms require a native app rebuild.

## Protocol and lifecycle

- The host submits a complete ordered scene. NIMO ignores per-element diff hints
  because every Update replaces the canvas, including text/image transitions.
- Launch, Update, and Exit use app ID `0xFD`. Frame fragments fit the negotiated
  characteristic write capacity, including the eight-byte transport header.
- Canvas commands wait for the normal connection handshake and a heartbeat
  confirming both TWS and the peer Companion connection. Status 7 waits for
  fresh readiness; retries are bounded. Status 8 blocks until reconnect.
- A business ACK confirms command acceptance, not optical rendering. It cannot
  advance the command state until the last GATT write completes. Ambiguous
  timeouts/errors retire the connection rather than reusing the command key.
- The most recent desired scene survives a link reconnect. Scene changes, Exit,
  disconnect, and native app takeover invalidate stale image encoding results.
- NIMO opts out of temporary welcome and brightness text so delayed clears cannot
  erase the active scene. Hidden dashboard updates never clear the visible view.
- Images are bounded before decoding, resized to their destination, composited
  over black, and packed with the same luminance/polarity as Android. Text,
  object, pixel, and serialized-frame budgets are validated before transmission.

## Validation and remaining device acceptance

Automated coverage includes the vendor's exact packet examples, both command
and transport lifecycles, image compression round trips, scene handoff,
foreground visibility, notification restoration, phone location, and miniapp
layout behavior. Apple tests run through the SDK's Swift package; its export
script also builds for generic iOS. Android checks use the generated Expo
project through `scripts/check-android-compile.sh`.

The original Android handoff reports controlled glasses evidence for Captions,
Translation, Mentra AI, Recorder, Teleprompter, and the Maps HUD. Most of that
work used firmware with a private framebuffer-readback extension. It is not
acceptance evidence for the final merged build or the new iOS port.

Run the following on **both Android and iOS**, recording app build, phone/OS,
glasses firmware, and device logs. Use the exact unmodified dynamic-v1 firmware.

1. Pair/reconnect, then run Captions with real microphone audio. Confirm wrapped
   rows, blank rows, Unicode, and changing partial text render correctly.
2. With a persistent miniapp scene active, disconnect/reconnect Bluetooth. Check
   that the scene remains visible beyond the former three-second welcome clear.
3. Switch Captions, Translation, Teleprompter, and Maps. Change brightness and
   auto-brightness; show/dismiss notifications; change the selected app while a
   notification covers it. The newest scene must return without stale content.
4. Exercise head-up/head-down and contextual dashboard toggles, including a
   dashboard scene replaced by legacy text. Check physical controls and native
   app takeover/return.
5. Background, lock, and return to the phone with real transcription active.
   Test longer sessions and removal/replacement of an arm to exercise readiness.
6. Walk a real Maps route: combined maneuver/arrow/distance/time/map HUD, reroute,
   normal arrival, stop/start another route, and ending navigation clearing the
   scene. Simulated routes do not establish physical-navigation acceptance.
7. Check any applicable remaining miniapps. The handoff reported Notes startup
   HTTP 401 and Merge provider-credit errors; recheck those service dependencies
   before claiming all-miniapp acceptance. Camera flows do not apply to this
   NIMO model, which also does not advertise a speaker.

No physical Android or iOS acceptance of this merged candidate is claimed.


## Text rendering migration

The handoff's per-miniapp NIMO profiles have been replaced by a migration to
host-owned text fitting. Captions and Translation supply transcript history in
one text element with `maxLines` and `textWindow: "end"`. Teleprompter uses
optional render feedback (visible lines and source line starts) while retaining
its own script, word cursor, voice matching, and replacement-frame behavior.
All three copied display-utils trees are removed. They require host 3.2.0.

The existing text element supports optional `maxLines`, `textWindow`, and
`verticalAlign`. Defaults preserve existing callers. G1/Z100 compile the new
controls using their text budgets and bypass a second legacy wrapping pass.
Replays retain source text and recompile against the current device's metrics.
G2 blank-row escaping is performed by the Android/iOS driver, not Teleprompter.
Public API details are in the display documentation. The earlier display design
notes' proposed public measurement helper is superseded; no helper or scroll
API is added to the SDK.

For acceptance, also check caption line-count/width/top-bottom settings with
interim speech, transcript previews, Teleprompter voice-follow and timed play,
manual forward/back steps, its timecode footer, final-page behavior, and changing
glasses during a read. Automated checks do not replace these hardware tests.
