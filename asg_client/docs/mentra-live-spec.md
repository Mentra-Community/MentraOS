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

### Camera capture

Mentra Live supports photo capture and video recording from the glasses camera.

- **Short camera-button press**: takes a photo unless video is currently recording, in which case it stops the recording.
- **Long camera-button press**: starts video recording unless video is already recording, in which case it stops.
- Photo/video resolution, FPS, max recording duration, and privacy LED behavior are configurable by commands from the phone app.
- Captured media is stored locally in package-namespaced storage and exposed to the phone through the camera web server for gallery sync.

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

### Local media sync server

`asg_client` runs an embedded HTTP server that lets the phone enumerate, download, ZIP, and delete captured media. This is used for gallery sync and avoids relying on cloud connectivity for local media transfer.

### Audio and microphone

Mentra Live exposes microphone/audio paths used for recording, streaming, and device audio cues. Battery warnings and other local prompts can use bundled audio assets. Audio behavior spans both MTK Android code and BES-controlled audio/Bluetooth firmware behavior.

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

When the phone requests the Mentra Live hotspot, `asg_client` creates an Android local-only hotspot rather than an internet-sharing tethered hotspot. Android generates the session SSID and password, which are returned to the phone over BLE. Credentials are scoped to the current reservation (and can change on every start), so clients must use the latest BLE status rather than save a fixed network. On current K900 builds the platform selects 2.4 GHz for this local-only AP. This keeps the glasses' `wlan0` station connection intact and lets a phone route glasses-local media traffic over WiFi while continuing to use cellular data for internet traffic. The hotspot remains active while the local HTTP server is receiving requests or streaming response data and automatically stops after 120 seconds of genuine HTTP inactivity.

### OTA and updates

Mentra Live has multiple update surfaces:

- `asg_client` APK/self-update.
- MTK/system firmware update flows.
- BES MCU firmware OTA over UART.

Update flows must preserve device recoverability, report progress where possible, and avoid interrupting active media operations without cleanup.

Legacy v1 JSON frames sent through BES are capped at a fixed 240-byte packed envelope. `wire_caps.notify_cap` is diagnostic only because it may describe a higher-capacity EATT bearer without guaranteeing that every notification will use that bearer. Terminal OTA success/failure is therefore sent as one compact notification; the state-rich diagnostic remains in the device logs.

Before BES authorization, ASG validates the immutable release identity, compressed hash and size, complete LZMA container and embedded CRC, decompressed hash and size, product marker, and embedded target version. The decompressed image must remain strictly below the BES bootloader's `0x1E0000`-byte flash limit. Authorization is persisted before the first `mh_ota` byte and may be attempted only once per glasses boot. A failed UART write is ambiguous: ASG retains exclusive OTA ownership and waits for `hm_ota`. If that framed reply is missing, ASG promotes its inbound route and sends up to three read-only, idempotent raw `0x99` protocol queries. A `0x9a` response proves BES is already in OTA mode and continues the transfer; the same five probe bytes contain no `##` marker and are harmless junk to the normal K900 parser. If raw probes are silent, ASG retains the exclusive lease, returns to normal framing, and requests `cs_syvr`. A framed `sr_syvr` proves BES stayed in normal mode and the UART return path works, permitting one bounded `mh_ota` resend. Only silence from both raw and framed probes leaves the state unknown and quarantines UART until reboot. The wire protocol uses the existing compact `install_failed` code for all BES install failures. The Mentra App conservatively treats any failed or locally timed-out BES install as restart-required, presents manual restart instructions, and withholds Retry until the user leaves that failure screen; detailed failure distinctions remain in ASG logs.

The MTK↔BES UART always starts at 460800 baud. Firmware that supports the negotiated fast link may upgrade to 1152000 only after reporting a compatible current firmware version. At startup, `asg_client` retries discovery at 460800 before making one bounded probe at 1152000, then returns to 460800 if neither rate answers. The alternate probe does not depend on app-local cached state, so an APK reinstall can recover a BES that survived at the negotiated rate. Once traffic confirms a negotiated 1152000 link, BES keeps that baud across UART driver restarts and Android sleep; ordinary phone heartbeats and expected MTK sleep silence must not return one endpoint to 460800. If an older BES nevertheless falls back or reboots while ASG remains alive, several small unframed reads or an idle-link health probe cause `asg_client` to verify 1152000, probe 460800, and renegotiate the fast link after finding BES at the rendezvous rate. If neither rate answers, ASG remains at 460800 and retries the two-rate scan with capped exponential backoff so a later BES boot cannot leave the endpoints split indefinitely. Each scan is bounded and recovery is suppressed during BES OTA, file transfer, and active baud transitions. After a successful BES OTA, BES reboots at 460800, so `asg_client` explicitly reopens the rendezvous baud, rediscovers the new firmware version, and negotiates again when supported. Older firmware on either side remains at 460800.

### Diagnostics and reporting

Mentra Live's canonical product serial is provisioned by the Android firmware in
`ro.serialno`. `asg_client` reads that property directly and forwards a valid
value to the phone as `serial_number` in `version_info_3`. It must not substitute
the generic `0123456789ABCDEF` Android/ADB placeholder—regardless of which
property exposes it—or a BES system-version field. The Bluetooth
MAC is sourced from BES (`hs_syvr`/`sr_btaddr`), persisted in
`persist.mentra.live.mac`, and republished to the phone as soon as it is learned.

`asg_client` includes logging, crash/error reporting, incident log buffering, and debug receivers for development and OTA testing. Production behavior should prioritize device stability and useful logs for support while avoiding secrets in logs.

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
4. Keep-alive/reconnect logic maintains the stream where supported.
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
