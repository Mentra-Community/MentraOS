---
status: draft
owner: alex
---

# Bluetooth SDK: Mentra Live telemetry and startup update check

## Goals

Mentra needs to know, per customer app:

- how many installs are actively running the SDK, and on which SDK version;
- what those installs do with Mentra Live: photos, videos, streams, mic use,
  connection time, setup and OTA outcomes;
- that developers on old SDK versions are told to update, without going
  through their business contacts.

The customer is identified by `app_identifier` (Android package name, iOS
bundle identifier), which every SDK event already carries.

Scope is Mentra Live and the SDK only; the glasses software is unchanged.
Camera, stream, Wi-Fi, hotspot and OTA events only occur on Live. Connection,
mic and button events fire for whichever glasses are connected and carry
`glasses_model`. No display telemetry is added.

## Two channels

| Channel | Controlled by | Sends | Destination |
| --- | --- | --- | --- |
| Usage telemetry | Existing analytics flag (Expo `analytics`, `BluetoothSdkAnalyticsConfig`, Android metadata, `Info.plist`) | Existing events plus the Live events below | PostHog, through the existing analytics queue |
| Startup update check | Always on | Install and SDK identity only | Cloud V2 Core, which records it in PostHog |

When analytics is disabled, the SDK sends nothing beyond the update check, and
the usage tracker below is never fed.

## Startup update check

### Client

On every SDK start, the SDK runs one update check. "Start" is the point where
`captureStarted()` runs today: `MentraBluetoothSdk` init on Android, and
`MentraBluetoothSDK.init` on iOS. In React Native that is once per JS runtime.

- The check runs off the caller thread and makes one HTTPS request with a
  4-second timeout. It has no retry, no queue and no persistence. A failure is
  silent and changes no SDK behavior.
- It runs regardless of the analytics configuration.
- It is skipped when the SDK version is unknown (`"unknown"` or empty).

`POST https://core.mentraglass.com/api/client/bluetooth-sdk/update-check` with
JSON:

| Field | Source |
| --- | --- |
| `install_id` | The persisted SDK install ID (the existing analytics `distinct_id`, `mentra-bt-sdk-<uuid>`). It is created on first use whether or not analytics is enabled, so both channels share one ID per install. |
| `app_identifier` | Package name or bundle identifier |
| `app_version`, `app_build`, `app_build_type`, `app_install_source`, `app_environment` | Same resolution as the existing host properties |
| `sdk_version`, `sdk_platform`, `sdk_surface` | Same as the existing base properties |
| `os_platform`, `os_version` | Same as the existing base properties |

Response:

```json
{
  "status": "current" | "update_available" | "unsupported" | "unknown",
  "channel": "latest" | "beta" | "dev",
  "latestVersion": "3.2.1",
  "minimumSupportedVersion": "3.1.0"
}
```

### Developer notice

When `status` is `update_available` or `unsupported`, the SDK prints a
multi-line banner at startup. It reprints the banner every 15 minutes while
that SDK instance is alive, and stops on `close()`. The notice never appears
in app UI and adds no listener callback.

- Android: `Log.w` under the SDK log tag.
- iOS: `NSLog`.
- React Native: native delivers the banner as the raw event
  `sdk_update_notice`, and `src/_private/nativeLogConsole.ts` turns it into
  `console.warn` alongside the native log console. In debug builds this shows as a LogBox
  warning, which only developers see.

The banner names the installed and latest versions and the update command for
the host's surface:

```
==================================================================
  MENTRA BLUETOOTH SDK UPDATE AVAILABLE
  Installed: 3.1.0    Latest: 3.2.1
  Update:    bun add @mentra/bluetooth-sdk@3.2.1
  Running an old SDK is the most common cause of glasses issues.
==================================================================
```

The update line depends on the surface:

| Surface | Update line |
| --- | --- |
| React Native | `bun add @mentra/bluetooth-sdk@<v>` |
| Android | `com.mentraglass:bluetooth-sdk:<v>` |
| iOS | the `MentraBluetoothSDK` Swift package at `<v>` |

For `unsupported`, the heading reads `MENTRA BLUETOOTH SDK <installed> IS NO
LONGER SUPPORTED`, and the banner adds that this version has known issues
fixed in newer releases.

### Core route

`cloud-v2/packages/core/src/api/client/bluetooth-sdk.api.ts`, mounted at
`/api/client/bluetooth-sdk`.

The route is unauthenticated. It is no more exposed than the PostHog write key
the SDK already embeds.

- **Validation:** strings are trimmed and length-capped (128 characters), and
  enum fields must match their known values. A malformed body gets `400` and
  records nothing.
- **Channel:** taken from the reported version. `X.Y.Z-dev.N` is `dev`,
  `X.Y.Z-beta.N` is `beta`, and anything else is `latest`.
- **Latest version:** Core reads the npm dist-tags for `@mentra/bluetooth-sdk`.
  Coordinated releases stamp the same identity into npm, Maven and SwiftPM, so
  one source covers every surface.
  - The tags are cached in memory for 10 minutes.
  - If a refresh fails, Core keeps serving the last value.
  - If Core has never had a value, it answers `unknown`.
- **Minimum supported version:** `BLUETOOTH_SDK_MIN_SUPPORTED_VERSION`, set in
  the shared Core Doppler config. Empty means there is no `unsupported` tier.
  A prerelease is compared on its base `X.Y.Z`.
- **Status:**
  - `unsupported` when the version is below the minimum.
  - Otherwise, `update_available` when it is below the channel's dist-tag.
    Prerelease numbers compare numerically within the same base.
  - Otherwise, `current`.
- **Recording:**
  - Core captures `bluetooth_sdk_update_check` into the same PostHog project
    the SDK writes to, with these properties:
    - `distinct_id` = `install_id`
    - every request field
    - `update_status`, `latest_version`
    - `$process_person_profile: false`, `$geoip_disable: true`
  - The capture is fire-and-forget after the response is built, so PostHog
    latency never delays the SDK.
  - Core uses the same public project write key that the SDK embeds, as a
    constant in the route module. It does not use Core's `POSTHOG_API_KEY`,
    which belongs to support profiles.

`bluetooth_sdk_update_check` is the canonical "install was active" signal for
every customer. Daily active installs per app is the count of distinct
`install_id` per `app_identifier` per day.

## Usage telemetry (Mentra Live)

All events below go through the existing `capture` path. That path handles
UUID and timestamp fixed at capture, the retry queue, and the shared base and
host properties.

Every event also carries the following, when known:

- **Phone:** `phone_manufacturer`, `phone_model`, `locale` and `timezone`.
  - `phone_manufacturer` / `phone_model` come from `Build.MANUFACTURER` /
    `Build.MODEL` on Android, and the `utsname` machine identifier on iOS.
  - `locale` and `timezone` are the device locale and time zone.
- **Glasses:** `glasses_model`, `glasses_device_id` (manufacturing serial) and
  `glasses_build_number`.

Each event is one occurrence. Nothing is aggregated on the device.

### Events

| Event | Emitted when | Properties |
| --- | --- | --- |
| `bluetooth_sdk_photo_taken` | An API `requestPhoto` settles, or a button photo fails on the glasses (`photo_response` with `requestId: "local"`) | `trigger` (`api` / `button`), `success`, `error_code`, `latency_ms` (API only), `photo_size`, `photo_mode`, `compress`, `save_to_gallery`, `transfer_method`, `file_size_bytes` (when the response carries it) |
| `bluetooth_sdk_video_recorded` | A recording ends (`recording_stopped`) or fails (failure `video_recording_status`) | `trigger` (`api` / `button`), `success`, `error_code`, `duration_ms`, `width`, `height`, `fps` (API overrides only), `save_to_gallery`, `max_duration_minutes`, `stopped_by_app` |
| `bluetooth_sdk_button_pressed` | The glasses report a button press | `button_id`, `press_type`, `gallery_mode_enabled` |
| `bluetooth_sdk_stream_started` | `startStream` resolves or rejects | `success`, `error_code`, `protocol` (`rtmp` / `srt` / `whip` / `unknown`), `width`, `height`, `fps`, `bitrate`, `capture_audio`, `glasses_network` (`wifi` / `hotspot`), `latency_ms` |
| `bluetooth_sdk_stream_ended` | The terminal `stream_status` for that stream | `protocol`, `duration_ms`, `end_state` (`stopped` / `reconnect_failed` / `error`), `stopped_by_app`, `reconnect_attempts`, `error_code`, plus the last `bitrate`, `fps`, `dropped_frames` and `temperature_c` when the stream reported stats |
| `bluetooth_sdk_glasses_disconnected` | A connection that emitted `bluetooth_sdk_glasses_connected` ends | `session_duration_ms`, `disconnect_reason` (`user_disconnect` / `forget` / `cancel` / `bluetooth_off` / `link_lost`), `battery_level_at_connect`, `battery_level_at_disconnect`, `charging` |
| `bluetooth_sdk_mic_session` | The active mic turns off or changes source | `duration_ms`, `mic_source` (`glasses` / `phone` / `bluetooth` / `bluetoothClassic`), `local_transcription` |
| `bluetooth_sdk_wifi_setup` | `sendWifiCredentials` settles | `success`, `error_code`, `latency_ms` |
| `bluetooth_sdk_hotspot_started` | `setHotspotState(true)` settles | `success`, `error_code`, `latency_ms` |
| `bluetooth_sdk_ota_finished` | `ota_status` reaches `complete` or `failed` | `success`, `failed_step_type`, `error_message`, `total_steps`, `duration_ms`, `from_build_number`, `from_bes_firmware_version`, `from_mtk_firmware_version` |
| `bluetooth_sdk_request_failed` | An awaited glasses command times out (the one place every command's wait ends) | `operation` (the command without request ids), `error_code` (`request_timeout`). At most 100 per SDK instance, so a failure loop cannot run up PostHog cost. |

### Sources

- **Glasses messages** are observed in the facade's event dispatch
  (`dispatchBridgeEvent` in `MentraBluetoothSdk.kt` and
  `MentraBluetoothSDK.swift`) before listeners run.
- **API outcomes and latency** are observed in the facade methods that await
  them.
- **Connections** are observed through the existing glasses-status
  observation.

Connection sessions live in the existing `BluetoothSdkAnalyticsTracker`, which
already sees every connected/disconnected transition. It records the connect
time and the battery levels seen during the connection. `disconnect`, `forget`
and `cancelConnectionAttempt` set a pending reason before the state flips. A
transition without one is `bluetooth_off` when the phone's Bluetooth is off,
otherwise `link_lost`. A connection that was already up when the SDK started is
not reported as ending.

A new pure tracker, `BluetoothSdkUsageTracker`, with one Android and one iOS
implementation, holds the rest of the per-occurrence state:

- open recordings by request ID, with the API parameters and whether the app
  stopped them;
- the open stream: start time, protocol, highest reconnect attempt, last
  stats, and whether `stopStream` was called;
- the active mic source, its start time and whether local transcription ran;
- OTA sessions by session ID, with their start time and starting versions;
- the request-timeout count.

It returns `AnalyticsEvent`s exactly like `BluetoothSdkAnalyticsTracker` and
owns no threads or I/O. Command outcomes and latency are measured around the
facade call; a caller cancelling the call is not reported.

Durations are measured on the phone's clock, from the start status to the end
status.

A stream or recording whose end never arrives in this process (for example,
the app was killed) produces only its start event.

`protocol` comes from the stream URL scheme, using the glasses' mapping:
`srt://` is SRT, `rtmp://` and `rtmps://` are RTMP, and `http(s)://` is WHIP.

`error_message` and any free-text error detail are cut to 200 characters,
with URLs removed.

### Never collected

- Photo, video or audio content.
- Transcripts.
- Stream, webhook or upload URLs.
- Auth tokens.
- Wi-Fi SSIDs or passwords.
- Location of any kind.

## Documentation

The following files describe the new events and an "Update check" subsection:
- `mobile/modules/bluetooth-sdk/README.md`
- `mintlify-docs/bluetooth-sdk/api-reference.mdx`
- `mintlify-docs/bluetooth-sdk/production-checklist.mdx`

The update check subsection says:
- The SDK checks for updates on every start, whatever the analytics setting.
- It lists the fields sent and the host (`core.mentraglass.com`).
- A network that blocks that host loses only the console notice.

The analytics flag is described as controlling usage telemetry.

## Testing

- **Android/iOS unit tests:**
  - `BluetoothSdkUsageTracker`: photo, video and stream lifecycles; durations;
    reconnect counting; disconnect reasons; mic sessions; the
    request-failure cap.
  - Version comparison and channel mapping.
  - Banner text per surface and status.
  - An update-check client that is skipped for an unknown version and is
    silent on failure.
- **Core (Bun):**
  - Request validation.
  - Dist-tag caching and stale fallback.
  - Status for each channel and the minimum-version tier.
  - The PostHog capture payload, using mocked `fetch`.
- **React Native (Jest):** `sdk_update_notice` produces one `console.warn`.
- **Device:** a Mentra Live run covering an API photo, a camera button press, a
  video recording, a stream start and stop, and a disconnect. Each expected event is
  confirmed in PostHog.

## Rollout prerequisites

- `BLUETOOTH_SDK_MIN_SUPPORTED_VERSION` is added to the shared Core Doppler
  config, initially empty.
