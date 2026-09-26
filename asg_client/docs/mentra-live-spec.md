# Mentra Live product and platform spec

This document is the standing product/platform reference for **Mentra Live** when working in `asg_client`. Treat it as required context before changing Mentra Live behavior, hardware integrations, command handling, media capture, connectivity, OTA, or user-facing device behavior.

## Purpose

Mentra Live is MentraOS's officially supported Android-based smart glasses device. It is both:

1. **A consumer smart-glasses product** for hands-free capture, streaming, app interactions, and status feedback.
2. **The reference hardware platform** for `asg_client`, the Android system app that bridges glasses hardware to the MentraOS phone app and cloud ecosystem.

In code and older docs, Mentra Live is often called **K900**. `K900` is an internal codename for the Mentra Live hardware platform, not a separate product.

## Product definition

Mentra Live consists of:

- Smart glasses hardware with camera, microphone/audio path, physical camera button, temple touch/swipe input, battery, sensors, WiFi/Bluetooth connectivity, privacy/status LEDs, and firmware-updatable components.
- An Android runtime on the glasses, powered by a Mediatek (**MTK**) SoC.
- A dedicated Bluetooth/audio microcontroller (**BES**) that handles low-level Bluetooth/audio behavior, button/touch events, battery reporting, pre-handoff and forced RGB status LED signaling, and BES firmware OTA.
- The `com.mentra.asg_client` Android app, shipped as a system app on production devices, which exposes the device to MentraOS.
- The MentraOS phone app, which pairs with the glasses over BLE, configures device behavior, syncs media, routes app events, and connects the user session to MentraOS Cloud.

## System role in MentraOS

Mentra Live is the glasses endpoint in this chain:

```text
Mentra Live hardware
  → BES MCU / MTK Android system
  → asg_client foreground service
  → BLE connection to phone app
  → MentraOS Cloud
  → MentraOS apps and app servers
```

The glasses do not directly run third-party MentraOS apps. Instead, `asg_client` reports device events and media state to the phone; the phone/cloud route those events to apps and route commands back to the glasses.

## Hardware and firmware architecture

### MTK Android side

The MTK side runs Android and hosts `asg_client`. It is responsible for:

- Camera access and media capture.
- Microphone access for recording/streaming paths.
- WiFi and hotspot operations.
- Local HTTP camera web server for media sync.
- APK/self-update flows for `asg_client`.
- Native local recording LED control through `libxydev.so` / `DevApi`.
- High-level orchestration of user-visible behavior.

### BES microcontroller side

The BES MCU is the low-level Bluetooth/audio controller. It communicates with MTK over UART using K900 protocol packets shaped like:

```json
{"C":"<command>","B":{...},"V":1}
```

For some outbound commands, `B` is a JSON object serialized as a string inside the outer JSON packet. BES is responsible for:

- Detecting and classifying camera-button presses.
- Reporting touch/swipe/power-button events.
- Battery reporting and forced charger status LED signaling.
- RGB status LED ownership when MTK has not claimed control.
- BES firmware OTA.
- Bluetooth/audio responsibilities specific to the glasses firmware.

## Core user features

### Pairing and phone connectivity

- Mentra Live pairs with the MentraOS phone app over BLE.
- `asg_client` exposes phone-facing commands and responses through the BLE command protocol.
- The phone is the user's primary UI for setup, WiFi configuration, gallery sync, app routing, and settings.
- Button/touch events are forwarded to the phone so apps can react even when the glasses also perform local actions.
- Secure owner-exclusive pairing is release-gated on both the Mentra App and BES and defaults off for Mentra 3.1. When enabled, three power-button presses enter pairing mode. ASG speaks “Connect to your Mentra Live in the app. Your code is:” plus the four-character code as one WAV, repeated by BES every 30 seconds, and speaks “Pairing mode ended.” when BES reports the window closing.

### Camera capture

Mentra Live supports photo capture and video recording from the glasses camera.

After a photo completes, the camera normally stays warm for 8 seconds for successive shots.

Bluetooth SDK photo requests can opt into `presend_thumbnail: true`. Compatible
phone SDKs receive a JPEG preview over BLE as `photo_status: thumbnail_received`,
with a local JPEG data URI, before full-photo delivery. The preview preserves
aspect ratio, never upscales, and is capped at a 500-pixel long edge at JPEG
quality 50. It requires an upload target and does not replace the full photo or
complete the capture request. Full-image BLE transmission waits for the preview
acknowledgement; a failed or timed-out preview fails the opted-in request.
Preview pixels use the full delivered image's display orientation: direct-upload
previews apply the upload source's EXIF rotation/mirroring. BLE previews and full
images normalize the source EXIF transform into their pixels (including RAM-first,
grayscale, and Wi-Fi fallback after a direct preview). Previews need no EXIF-aware renderer.
Direct full uploads continue preserving EXIF orientation and IMU metadata.
The opted-in request has one end-to-end SDK deadline of 110 seconds: 45 seconds
for capture + 30 seconds for preview transfer/retries and ACK + 30 seconds for
full delivery + 5 seconds for command/terminal-event transit. The glasses job
watchdog is 105 seconds from admission; progress and preview ACK do not reset it.
The constants live in `AsgConstants` and are mirrored in both native Bluetooth
SDK facades. Ordinary SDK photo requests retain their 30-second deadline.
Requests that omit the option retain their existing transfer behavior.

- **Short camera-button press**: takes a photo unless video is currently recording, in which case it stops the recording.
- **Long camera-button press**: starts video recording unless video is already recording, in which case it stops.
- Photo/video resolution, FPS, max recording duration, and privacy LED behavior are configurable by commands from the phone app.
- Photo/video starts and ongoing video/streaming retain the normal 15% battery minimum. Known 4–14% requires fresh BES `hm_batv.B.active_charging: true` (SY5502 phases 3/4/5, not full or merely plugged in); known 0–3% is always blocked. Missing/false charge evidence grants no exception. Unknown SOC keeps its existing behavior and is not charge evidence.
- Charge evidence is paired with the same reply's SOC, timestamped before event delivery using elapsed realtime, and invalidated by UART proof reset/recovery; older queued events cannot restore it. Low-battery use requests `mh_batv` after 5 seconds and expires evidence after 30 seconds. At the normal 10-second monitoring cadence, unplugging is queried on the next tick and acted on the following tick (about 20 seconds); silent UART failure stops use on the first check at expiry (at most about 40 seconds after the last receipt). These are polling bounds, not hard real-time deadlines. Normal cleanup is retained, and stream reconnect starts recheck the policy before opening the camera.
- Queue admission is not lasting permission to capture: photos recheck before the shutter and videos recheck after teardown and camera preparation. All paths use the hardware battery cache when available; UART evidence also requires a ready transport under normal OTA policy.
- Captured media is stored locally in package-namespaced storage and exposed to the phone through the camera web server for gallery sync.
- **Warm photo capture** prepares the audio bridge at request acceptance but does not play a shutter until the capture's exposure callback (or final-frame fallback). Queued captures retain their own feedback tokens. A button press alone is never evidence that an image was taken.
- **Cold photo capture** (camera startup required): plays a short, intentionally subtle hold-still prep click immediately and every 900ms during camera/ISP startup, then requests the clicks to stop when sensor exposure starts. On Mentra Live, an in-progress beep finishes before the sequence stops in its silent portion; the shutter sound waits for that stop without delaying the photo. Camera feedback preloads 48 kHz stereo PCM into reusable static AudioTracks. The prep track loops one 900ms click-and-silence period fifty times, preserving the existing 45-second sequence sample-for-sample without per-click timers or decoder restarts. A busy or failed static track falls back to the original MediaPlayer asset; the prep fallback remains the lossless 45-second sequence. Playback still waits for BES readiness, preserves notification volume/routing and other audio ownership, and releases cached native tracks on controller teardown. Each beep occupies the first 186ms of its 900ms period; normal stop requests target the 240–800ms silent window using playback position and recheck it after timer delays. Service teardown still stops all audio immediately. After AE first converges, cold captures preserve a 475ms minimum exposure-settling window before submitting the still request; warm-session captures keep the adaptive stable-frame fast path.
- All single-frame captures use Camera2 `onCaptureStarted` as the hardware anchor. The snap targets 100ms before estimated exposure end (manual duration when fixed; latest preview-metered duration for auto exposure), which keeps it immediate in bright scenes and avoids an early cue during longer low-light exposures. If the completed JPEG reaches `ImageReader` first—as can happen when a HAL delivers `onCaptureStarted` late—the frame callback plays the snap immediately, before extraction or persistence. HDR bursts use the final bracket's exposure/frame callbacks so the user remains still for the whole burst. The final captured callback remains an idempotent last-resort fallback.
- Prep clicks and snaps use isolated audio overlays so camera feedback does not cut off unrelated device prompts. The shutter snap uses a deliberately prominent playback gain so it remains distinct from the quieter prep cue. A failed capture cancels only its own feedback; an already-playing prep beep is allowed to finish.
- Photo requests turn on the front-facing MTK privacy LED and BES white RGB indicator together at acceptance. Both remain requested on until final-frame availability and for at least 1500ms from acceptance, whichever is later. Overlapping requests retain separate leases; one completed shot cannot extinguish another. Failure uses the same minimum duration; the photo-job watchdog also releases the matching request’s feedback lease if no camera callback arrives, without releasing independent camera or streaming ownership. If another privacy owner remains, RGB OFF is deferred until that owner releases, even if no photo callback follows. Service teardown releases immediately. The camera's independent submission-time privacy lease remains as a safety gate through final JPEG arrival. Other recording/streaming owners retain their privacy indication.
- LED operations share a logical lifecycle, but MTK GPIO and BES UART are separate hardware paths; physical edge simultaneity requires device measurement. Likewise, the exposure-anchored snap compensates for an estimated 100ms playback lead; callback, metering, multi-frame processing and audio latency prevent a guarantee of exact acoustic synchronization. Final-frame callbacks are the conservative fallback when exposure timing is unavailable.

### Gallery-mode behavior

The phone controls whether a physical button press should capture locally through `save_in_gallery_mode`. The "phone connected" input to that decision is the **BES-reported phone BLE presence** (BES firmware >= 17.26.7.23 reports `sr_phble` connect/disconnect edges and syncs `phone_ble` in every `sr_syvr` reply), which is a tri-state: `PRESENT`, `ABSENT`, or `UNKNOWN` when no signal has arrived — old BES firmware never reports presence, so on the deployed fleet the value stays `UNKNOWN`.

| Gallery mode | Phone presence | Local capture behavior |
| --- | --- | --- |
| Enabled | Any | Capture locally. |
| Disabled | `PRESENT` | Do not capture locally; forward the press and let the phone/app flow handle it. |
| Disabled | `ABSENT` or `UNKNOWN` | Capture locally so the user action is not lost. |

`UNKNOWN` is deliberately treated as "no phone": the accepted trade-off is a possible duplicate capture (glasses and phone app both capture) rather than a lost photo. In particular, on BES firmware without presence reporting, disabling gallery mode does **not** suppress local capture even while a phone is connected.

Every camera-button press should still be forwarded to the phone as a `button_press` event regardless of the local-capture decision.

### Live streaming

Mentra Live supports camera/microphone live streaming paths from `asg_client`, including RTMP, SRT, and WHIP services. Streaming behavior must coordinate camera ownership, microphone foreground-service requirements, reconnect/keep-alive handling, and privacy LED state.

Camera FOV synchronization is idempotent against the last successfully submitted hardware crop,
not just saved preferences. Startup, persistent settings, and temporary override leases use the
same gate. An unchanged crop never restarts the HAL. A changed crop is rejected as `camera_busy`
while a publisher is pending, live, or reconnecting; while a photo/video or warm-camera service
owns the camera; or while USB webcam capture is active. Busy persistent changes are not saved.
Override release/expiry retains ownership until the saved crop can be restored safely.
Direct-upload and BLE JPEG encoding share one `compress` policy: `none` = Q95, `low` = Q88,
`medium` = Q78, and `high` = Q60. Omitted compression defaults to `none`; invalid values are rejected.
Photo compression omission is distinct from an explicit `null`: requests default
omission to `none`, and partial preset updates leave an omitted compression field
unchanged. A supplied `null` or other invalid value is rejected. Stored presets
containing removed values are invalid; replace their compression with one of the
four supported values before replaying the complete preset. There is no automatic
migration or substitution. Fresh valid preset updates remain available.

Cloud photo allocation takes no photo options: the authenticated endpoint only
returns upload/download URLs and ignores any supplied body. The phone sends size,
compression, sound, and gallery-saving choices to the glasses separately.

Direct upload re-encodes every level, including omitted/`none` compression at Q95,
at the captured/cropped dimensions and carries EXIF orientation, IMU data, and capture ID
over. The original capture's size-dependent JPEG quality does not override this delivery
policy. Compression no longer applies an extra 75% or 50% resize. The size tier independently
controls pixel limits, including the existing BLE-specific caps. Wi-Fi fallback reuses
the original capture and the same quality, never the already-compressed upload copy.
Warm-camera leases default to 15 seconds and support requested holds up to 5 minutes.
FOV `ready` acknowledgments wait for delayed camera tuning to finish, its subsequent
restart cooldown, and Camera2 camera
re-registration (including readable characteristics). If registration does not recover
within 20 seconds, glasses return `camera_unavailable` instead of reporting ready.
FOV commands have one active update and one pending slot. A new pending command replaces
and immediately rejects the previous pending command as `fov_superseded`, without applying
it. This applies to persistent settings, overrides, and releases. A completed
update with a pending successor returns `status: error`, `ready: false`, and
`error_code: fov_superseded` before the successor starts; only the final update reports
ready. Registration timeout also fails the pending update. Android and iOS SDK FOV calls allow
45 seconds: at most two 20-second readiness waits plus a 5-second BLE delivery margin
(`AsgConstants.CAMERA_FOV_REQUEST_TIMEOUT_MS`, mirrored in both SDK facades). Other
settings retain their 15-second deadline. Lease expiry restoration waits
behind active updates. Duplicate lease refreshes use the same readiness gate.
On miniapp exit the phone orders release after its capture cleanup, stops renewing a rejected
release, and retries release on reconnect. The existing ASG lease TTL bounds abandoned ownership;
expiry waits for camera-idle rather than resetting the HAL during another app's capture.

Miniapps observe publisher recovery rather than creating a second stop/restart loop from Wi-Fi
or BLE observations. Retry intent survives forwarding through the phone. Terminal publisher
failures require fresh user intent to start another session. Stream teardown attempts camera,
microphone, encoder, muxer, and endpoint cleanup independently, even after a camera HAL error.
Camera-device loss after opening is a terminal device failure, not a network reconnect.
Its callback reaches the stream owner off the Camera2 callback thread, and callbacks from a
closed or replaced camera session cannot terminate the current publisher.

The OS-1937 streaming lifecycle is owned by the phone's explicit start/stop commands, not by
cloud-era per-stream keep-alives. A stream may otherwise end on terminal publisher or device
failure, or after sustained loss of the controlling phone. BES phone BLE presence is authoritative;
the MTK-to-BES UART connection is not evidence that the phone is connected. A 10-second phone-loss
grace tolerates brief BLE outages. Reconnection cancels that deadline, while repeated absence or
unknown-presence reports never extend it. Deadline work is scoped to a stream generation so an
old callback cannot stop a replacement stream, even if its public id is reused.

Starting a stream requires confirmed phone presence. If the cached state is absent or unknown,
ASG requests `cs_syvr` snapshots from BES every 400ms for up to two seconds before rejecting the
start. Stop, replacement start and handler cleanup cancel that pending admission. Refreshes use
the UART coordinator and cannot interrupt file/OTA ownership or baud recovery. `phone_ready`
also requests a snapshot; receipt of a phone command never directly sets presence to connected.
BES builds that do not expose that signal
must be updated before starting phone-owned streaming; unknown presence must not authorize an
indefinitely running camera. If presence becomes unknown during a stream (for example, during
BES transport recovery), the same bounded grace applies.

BLE presence does not prove the controlling app is executing. Updated native SDKs attach
`controllerProbeVersion: 1` and a process-scoped `controllerId` to each start. ASG rejects starts
without that support, sends a fresh native controller challenge every two seconds, and stops
after ten seconds without a matching response. Retransmissions and duplicate/late responses
never renew this deadline. Challenges are answered directly in the native BLE receive path,
without JavaScript, cloud connectivity, or a phone-side periodic timer.
Replies use the transport's MTK wake flag: BES can buffer non-waking phone commands after
Android enters standby even while the stream's CPU wake lock keeps media running. A valid
native challenge response must reach ASG before its existing deadline.
The controller identity survives BLE reconnects but changes after app termination; reopening
the app cannot silently
take over the old session. Both phone-presence and controller-response checks must remain healthy.
Physical qualification must verify screen-off/background operation, force-kill on both phone
platforms, and short BLE outages before release; native callback wake behavior is not proven by
unit tests.

WHIP streams seed WebRTC with an explicit initial send bitrate capped by the caller's configured maximum. Congestion control remains enabled so the sender can still reduce bitrate on constrained networks instead of treating the configured bitrate as a fixed rate.

Streaming endpoints on the active Mentra Live hotspot subnet are reachable without a separate STA WiFi connection. `asg_client` derives that subnet from the live hotspot interface rather than assuming fixed client addresses. For WHIP, the WebRTC network inventory must also expose the hotspot interface so ICE can gather a directly reachable local candidate.

### Local media sync server

By default, while the Mentra Live hotspot is active, `asg_client` runs an embedded HTTP server that lets the phone enumerate, download, ZIP, and delete captured media. That server stops with the hotspot and binds only to the hotspot gateway address. This is the default gallery behavior and avoids relying on cloud connectivity for local media transfer.

Enterprise clients can explicitly keep that same server running using the Bluetooth SDK's `setGalleryServerEnabled(enabled)` command. This setting defaults off and is saved across BLE reconnects and glasses restarts until explicitly disabled. When enabled, the existing server binds port 8089 on all local interfaces, so clients can use the glasses' site-network IP without joining a hotspot. The HTTP API is identical in both modes, including capture, listing, downloads, sync, deletion, restore, and browser assets. Completed-media filtering, resumable downloads, and camera callbacks are unchanged.

Persistent gallery access has no authentication or encryption: any reachable client can use the full camera/gallery API. Enable it only where that access is acceptable. The server remains running through Wi-Fi disconnection and address changes, and retries startup failures every five seconds. Disabling restores hotspot-only behavior, rebinding to the active hotspot address or stopping if no hotspot is active. Mode changes restart the listener and can interrupt in-flight HTTP requests. The command acknowledgement distinguishes the saved `enabled` setting from current site-network availability (`listening`) and includes `url` only when a station Wi-Fi endpoint is available.

If saving the gallery setting fails, the command returns an error and restores the previous in-memory value before reconciling the server. A failed enable must not expose the site-network API immediately or on later hotspot events or retries.

### Audio and microphone

Mentra Live exposes microphone/audio paths used for recording, streaming, and device audio cues. Battery warnings and other local prompts can use bundled audio assets. Audio behavior spans both MTK Android code and BES-controlled audio/Bluetooth firmware behavior.

Local ASG cues wait asynchronously for a correlated BES I2S-ready reply before starting PCM
on firmware advertising `wire_caps.i2s_ready: 1`. BES replies only after its audio thread
has opened the receiver and armed speaker output. ASG retains the bridge for 750ms between
cues, including camera prep-to-snap transitions; shutdown still stops it immediately.
Warm, immediately admitted photo requests enqueue bridge readiness before asynchronous
capture and camera configuration reporting, preventing that shot's chunked status
messages from delaying audio-start. An unused reservation expires after the same 750ms
grace; queued captures still wait for exposure and external audio retains bridge ownership.
Old BES firmware uses a 250ms compatibility delay. A missing readiness reply on capable
firmware cancels the cue after 1500ms instead of knowingly playing into an unready input.

### LEDs and user feedback

Mentra Live has two LED systems:

1. **Local MTK recording/privacy LED** — controlled directly by MTK through native APIs; used for camera-in-use feedback.
2. **BES RGB status LED** — controlled by BES during early boot and by forced/direct BES paths for charger transitions, firmware updates, and shutdown; MTK claims authority once UART is ready and sends camera or app-requested RGB commands.

Camera and streaming features must leave LEDs in a safe state on stop, error, service shutdown, or command cancellation. User-visible privacy indication should not be bypassed accidentally.

### Buttons and gestures

- Camera button short/long press drives photo/video behavior and app events.
- Touch/swipe events are forwarded to the phone as status or input events.
- Power-button short press can trigger battery-level audio feedback.
- Power-button hold/graceful shutdown should finalize active recordings before powering down to avoid corrupt media.

### WiFi and hotspot management

The phone can configure WiFi behavior through `asg_client`. Mentra Live-specific network managers should be used when platform APIs are required; generic Android fallbacks exist for non-K900 paths.

The phone can request saved SSIDs with a correlated request/response and can ask the glasses to forget a network. Modern commands require the complete `protocolVersion: 1`, nonempty `requestId`, and current process `sid` tuple. Partial, malformed, and future versions are rejected before a backend read or mutation. Legacy forget commands omit all three fields. Native SDKs negotiate from `version_info_1` under one bounded request deadline; modern operations never fall back to `wifi_status`. Legacy requests resolve immediately as `legacy_unverified` once an active native transport accepts dispatch, without waiting for a link-state change. K900's current vendor API only dispatches an asynchronous SystemUI broadcast: its correlated forget outcome is `dispatched`, not verified credential removal. The current WiFi link snapshot is included separately because Android may propagate disconnection later. K900 saved-network enumeration is explicitly unsupported until the vendor API exposes a response path; do not substitute the potentially empty/stale framework configured-network list.

When the phone requests the Mentra Live hotspot, `asg_client` starts the K900 firmware hotspot through the SmartXY `ap_start` intent. It waits for the AP gateway and firmware-configured SSID/password before returning them to the phone over BLE. Clients must use the latest BLE status rather than assume fixed credentials. The hotspot remains active while the local HTTP server is receiving requests or streaming response data, or while a hotspot-local stream owns an active session. Stream activity is refreshed locally, independently of phone/cloud heartbeats. It automatically stops after 120 seconds without any of those activity signals.

### OTA and updates

Mentra Live has multiple update surfaces:

- `asg_client` APK/self-update.
- MTK/system firmware update flows.
- BES MCU firmware OTA over UART.

Phone-pinned `asg_client` APK downgrades are supported when the target version code is at least
`51518114` (Mentra 3.0). Older targets predate the downgrade-safe media and recovery contract and
must be refused.

**Downgrade release invariant:** the MentraOS phone app and `asg_client` are kept aligned
through coordinated releases. For supported releases, a higher installed ASG version from
which the phone offers a downgrade already supports the downgrade/recovery contract and
has the downgrade floor enabled. Phone-side availability checks therefore rely on this
release invariant rather than a separate minimum-installed-version or capability gate.

The shipped downgrade floor must never decrease. It may increase to retire older targets,
but any increase must be coordinated across ASG, the recovery worker, Engine, and the Swift
and Kotlin SDK defaults so the phone only offers targets accepted by the aligned glasses.
The supported-source invariant must continue to hold when the floor increases. Explicit
floor overrides used by tests do not change this release policy.

Update flows must preserve device recoverability, report progress where possible, and avoid interrupting active media operations without cleanup.

An `ota_query_status` with `include_activity: true` and a bounded `request_id`
also records a read-only activity snapshot in local diagnostics. It identifies
the process and request and exposes the existing OTA admission, APK/MTK/BES busy
state and pending APK restart guard without expiring sessions or starting work.
Its process-local admission generation increases on each accepted OTA admission;
`consistent` is false if an admission occurs during the snapshot itself.
Unknown owners remain unknown. Ordinary query responses and compact terminal BLE
frames retain their existing behavior; a terminal BES result alone is not proof
that every updater is idle.

The durable BES terminal result also settles its matching top-level OTA session's
final BES install step, even when the phone is disconnected or ASG must replay the
result after a process restart. A result from another session, an unfinished BES
transaction, or an earlier step cannot finish the current session; existing session
failures remain failures. This reconciliation starts no update or next step.

MTK updates prefer an incremental patch whose start version matches the glasses.
If no patch matches, a pinned `mtk_full_ota` can update a known older firmware
directly. Full fallback requires a valid target version, URL, SHA-256, and size;
unknown, equal, or newer installed versions do not qualify. A failed incremental
does not silently switch to a full image. Both paths use the existing user-approved
installation and Android compatibility checks; full OTAs do not enable rollback
or request a userdata wipe. Release manifests pin the full artifact, including
when the phone downloads and serves it over the glasses hotspot.
Glasses reuse `asg/mtk_firmware.zip` rather than retaining one file per release.
MTK downloads are capped at 1 GiB and reserve room for the ZIP plus payload
before downloading when the artifact size is known. Historical development
packages and post-install space reclamation are separate from this fallback.
Download liveness uses actual received bytes, not just rounded percentages;
repeated status replies do not count as transfer progress. A phone timeout does
not release an active MTK system install: ASG retains ownership until the system
updater reports a terminal result (or the process/device restarts), preventing a
retry from replacing its staged ZIP. Release packaging checks declared full-OTA
size against the same bytes whose SHA-256 is verified.

The MTK↔BES UART always starts at 460800 baud. Firmware that supports the negotiated fast link may upgrade to 1152000 only after reporting a compatible current firmware version. At startup, `asg_client` retries discovery at 460800 before making one bounded probe at 1152000, then returns to 460800 if neither rate answers. The alternate probe does not depend on app-local cached state, so an APK reinstall can recover a BES that survived at the negotiated rate. Once traffic confirms a negotiated 1152000 link, BES keeps that baud across UART driver restarts and Android sleep; ordinary phone heartbeats and expected MTK sleep silence must not return one endpoint to 460800. If an older BES nevertheless falls back or reboots while ASG remains alive, several small unframed reads or an idle-link health probe cause `asg_client` to verify 1152000, probe 460800, and renegotiate the fast link after finding BES at the rendezvous rate. If neither rate answers, ASG remains at 460800 and retries the two-rate scan with capped exponential backoff so a later BES boot cannot leave the endpoints split indefinitely. Each scan is bounded and recovery is suppressed during BES OTA, file transfer, and active baud transitions. After a successful BES OTA, BES reboots at 460800, so `asg_client` explicitly reopens the rendezvous baud, rediscovers the new firmware version, and negotiates again when supported. Older firmware on either side remains at 460800.

### Diagnostics and reporting

Requested version information is returned as a correlated, explicitly complete
snapshot: both chunks echo the request ID and process `sid`, and include their
index, total count, and final marker. The phone waits for all declared chunks;
it never reports partial version data as complete because the transport went quiet.
Older firmware's `version_info_3` remains the immediate terminal boundary for a
legacy sequence that began with `version_info_1`.

Explicit `get_stream_status` queries can carry a bounded `request_id`, echoed only
on that response so queued older snapshots cannot satisfy a fresh query. Actual
current-session BES UART version diagnostics include `elapsed_realtime_ms`, sampled
from Android's monotonic elapsed realtime before reading OTA state. Phone clock
synchronization does not change these freshness signals. Neither field starts an
update or changes stream state; clients omitting the request ID retain existing behavior.

Mentra Live's canonical product serial is provisioned by the Android firmware in
`ro.serialno`. `asg_client` reads that property directly and forwards a valid
value to the phone as `serial_number` in `version_info_3`. It must not substitute
the generic `0123456789ABCDEF` Android/ADB placeholder—regardless of which
property exposes it—or a BES system-version field. The Bluetooth
MAC is sourced from BES (`hs_syvr`/`sr_btaddr`), persisted in
`persist.mentra.live.mac`, and republished to the phone as soon as it is learned.
The MTK Wi-Fi interface MAC is read from Android's Wi-Fi service and forwarded
separately as `wifi_mac_address` when available.

`asg_client` includes logging, crash/error reporting, incident log buffering, and debug receivers for development and OTA testing. An engineering-only audio reproduction harness (`audio_repro_*` commands, `tools/audio-repro/`) replays scheduled cue, capture and bridge sequences; it refuses every command unless an adb-created gate file exists, and its trace hooks are inert without an active run. Production behavior should prioritize device stability and useful logs for support while avoiding secrets in logs.

## How Mentra Live works at runtime

### Service startup

1. Android boots or the app is launched.
2. `AsgClientBootReceiver` / launcher flow starts `AsgClientService`.
3. `AsgClientService` runs as a foreground service with camera/microphone capabilities.
4. The service initializes managers for Bluetooth, hardware, network, media, settings, server, sensors, OTA, and reporting.
5. The glasses advertise/accept BLE communication from the phone app.

### Phone connection

1. Phone connects over BLE and sends readiness/configuration commands.
2. `asg_client` responds with device status and applies persisted or received settings.
3. For Mentra Live, MTK claims RGB status LED authority as soon as the BES UART transport is ready, then reasserts it after phone readiness.
4. Ongoing commands are dispatched through command handlers and responses are sent back over BLE.

### Process session identity

Each `asg_client` process generates a session id (`sid`, 8 hex chars) at startup and
carries it in `glasses_ready` and `version_info_1`. The BES keeps the phone's BLE link
alive across `asg_client` restarts (APK OTA, crash recovery), so the phone cannot detect
a restart from transport state; a changed — or newly appearing — `sid` is the explicit
restart signal. On observing it, the phone re-runs its readiness flow (`phone_ready` →
`glasses_ready`, wire re-negotiation) and treats it as the OTA reconnect edge. Builds
without the field get the phone's legacy behavior; the field first appearing right after
an update from such a build is itself treated as a restart (that transition is the
upgrade OTA completing).

### Camera button photo flow

1. User short-presses the camera button.
2. BES classifies the press and sends `cs_pho` or an equivalent notification over UART.
3. `K900CommandHandler` forwards a `button_press` event to the phone.
4. The gallery-mode gate decides whether local capture should occur.
5. If local capture is enabled, `MediaCaptureService` takes a photo using the configured size and LED setting.
6. The media file is stored locally and becomes available through gallery sync / camera web server APIs.

### Camera button video flow

1. User long-presses the camera button.
2. BES sends `cs_vdo` or equivalent over UART.
3. `asg_client` forwards `button_press` to the phone.
4. If local capture is permitted and battery is above the minimum threshold, video recording starts with configured resolution/FPS/max duration.
5. LEDs indicate active camera use.
6. A subsequent short or long press stops the recording, finalizes the file, turns off recording indicators, and exposes the file for sync.

### Streaming flow

1. Phone or another authorized command source sends a stream-start command with destination/protocol configuration.
2. `asg_client` starts the appropriate streaming foreground service.
3. The service acquires camera/microphone resources, sets privacy indicators, and connects to the streaming endpoint.
4. The glasses maintain resource leases locally and report publisher reconnect/failure state. Sustained phone BLE loss or an unresponsive native controller ends the session after its bounded grace.
5. Stop, error, or disconnect paths release camera/microphone resources and reset LEDs.

### Media sync flow

1. Captured media remains on the glasses until downloaded or deleted.
2. The phone discovers the glasses' local server endpoint.
3. The phone enumerates files, downloads media or ZIP bundles, and requests deletion when appropriate.
4. File-manager package namespacing prevents one requesting app's media operations from unintentionally affecting another app's files.

## Implementation principles for `asg_client`

When changing Mentra Live behavior:

- Preserve the phone as the primary control plane; avoid adding glasses-only behavior that cannot be configured, observed, or reconciled by the phone app.
- Forward user input events before local side effects when existing behavior requires apps to observe every press.
- Keep the gallery-mode gate semantics stable unless intentionally changing the product behavior and docs together.
- Treat `K900` code paths as Mentra Live code paths.
- Clean up camera, microphone, wake locks, streams, recordings, and LEDs on every stop/error path.
- Do not leave BES RGB authority claimed or LEDs stuck on during service shutdown.
- Keep media operations package-scoped through the file-manager APIs.
- Prefer command-handler isolation for new phone-facing commands.
- Include physical-device testing plans for camera, BLE, button, LED, OTA, WiFi, or streaming changes because emulators cannot validate the complete Mentra Live behavior.

## Related references

- [`overview.md`](overview.md) — `asg_client` architecture and K900 naming notes.
- [`ASG_CLIENT_API.md`](ASG_CLIENT_API.md) — phone/glasses command protocol.
- [`features/button-press-system.md`](features/button-press-system.md) — camera button and gallery-mode behavior.
- [`features/led-control.md`](features/led-control.md) — local privacy LED and BES RGB status LED behavior.
- [`features/rtmp-streaming.md`](features/rtmp-streaming.md) — live streaming lifecycle.
- [`features/camera-web-server.md`](features/camera-web-server.md) — local media sync server.
- [`features/bes-ota.md`](features/bes-ota.md) — BES firmware update flow.
