# @mentra/bluetooth-sdk

React Native and Expo SDK for connecting mobile apps directly to supported Mentra smart glasses over Bluetooth.

The package includes:

- A React Native / Expo module API exposed as `BluetoothSdk`.
- React hooks under `@mentra/bluetooth-sdk/react` for common scan,
  connection, status, and event lifecycles.
- Native Android code published as `com.mentraglass:bluetooth-sdk`.
- Native iOS and macOS code available as the `MentraBluetoothSDK` Swift package.
- Native macOS Expo Modules adapter for `react-native-macos` hosts.
- An Expo config plugin that wires the native dependencies into generated Android and iOS projects.

Use a development build or production native build. Expo Go cannot load this package because the SDK contains native code.

## Diagnostics

After importing the SDK, native Android and iOS SDK diagnostics are forwarded
automatically to the JavaScript console, alongside your app's JS logs. Entries
are prefixed with `[native:android]` or `[native:ios]`. You do not need to add a
`log` listener just to print them; doing so would print them twice. The existing
`log` event remains available for custom consumers.

Credential-bearing messages are redacted before console output, and individual
messages are capped at 16,384 characters. The Mentra App's incident reports
capture this same combined console stream in the phone log attachment, subject
to its existing retention limits. Native diagnostics are also kept in the native
console. Forwarding covers SDK-owned diagnostics while the JS runtime is active,
not arbitrary OS or third-party native logs or logs from before subscription.

On Android, forwarding to JavaScript is capped at 100 messages per second. Each
forwarded message holds a JNI global reference until the JavaScript thread drains
it, so an unbounded log source can exhaust the process-wide reference table and
abort the app rather than merely slow it down. Messages above the cap are withheld
from the JavaScript stream only — they are still written to the native console —
and the next forwarded message is preceded by a notice saying how many were
withheld. Per-frame microphone payload events are not traced at all; audio faults
are still reported through the `mic_health` event.

Rebuild the native app after updating the SDK to pick up both platforms' logging
changes. Adding this JS package alone cannot reroute logs in an older binary.

## Requirements

- React Native `0.72+`.
- Expo `49+` when using Expo.
- Android min SDK `28+`.
- iOS deployment target `15.1+`.
- Native macOS deployment target `13+`. The Starter Kit's separate
  `react-native-macos` host requires macOS `14+` and a matching React Native / Expo
  Modules toolchain; the iOS/Android config plugin does not generate a Mac host.
- A physical phone for real Bluetooth testing.
- Bluetooth permissions, plus Android location permission where BLE scanning requires it.

## Install

```sh
bun add @mentra/bluetooth-sdk
bunx expo install expo-build-properties
```

For Expo apps, add the plugin to `app.json` or `app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "node": true
        }
      ],
      [
        "expo-build-properties",
        {
          "android": {
            "minSdkVersion": 28,
            "packagingOptions": {
              "pickFirst": [
                "**/libc++_shared.so",
                "**/libonnxruntime.so",
                "**/libonnxruntime4j_jni.so"
              ]
            }
          }
        }
      ]
    ]
  }
}
```

Then regenerate native projects and run a development build:

```sh
bunx expo prebuild
bunx expo run:ios
# or
bunx expo run:android
```

## Permissions

Android apps should request the permissions required by the features they use:

```json
{
  "android": {
    "permissions": [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS"
    ]
  }
}
```

Some Android 12+ devices require Location permission and Location services before BLE scan callbacks are delivered.

### Android Foreground Service Types

The SDK service reads its allowed types from the merged Android manifest.
The default manifest retains MentraOS's connected-device, microphone, location,
media-playback and data-sync capabilities. A Bluetooth-only host can override
`com.mentra.bluetoothsdk.services.ForegroundService` to use `connectedDevice`
with `tools:replace="android:foregroundServiceType"`, and remove unused typed
FGS permissions from its final manifest. Startup then uses `connectedDevice`
instead of `dataSync`; the SDK's `CHANGE_WIFI_STATE` permission satisfies its
startup prerequisite even before a Bluetooth runtime permission is granted.

Only restrict types when the corresponding background features are unused.
Receiving the glasses' BLE audio is distinct from selecting Android's phone or
Bluetooth headset microphone. Hosts using Android microphone capture, location
tracking or background media playback must retain the corresponding types and
permissions, including those required by other native modules. At least
`connectedDevice` or `dataSync` must remain for SDK service startup.

iOS apps should include usage descriptions:

```json
{
  "ios": {
    "infoPlist": {
      "NSBluetoothAlwaysUsageDescription": "This app connects to your smart glasses over Bluetooth.",
      "NSMicrophoneUsageDescription": "This app uses the microphone when you enable audio features.",
      "NSLocalNetworkUsageDescription": "This app connects to local photo and streaming helpers during development."
    }
  }
}
```

## Minimal Usage

Use `scan()` when your app needs to show a picker. It calls `onResults` every time the discovered list changes, then resolves with the final list after the timeout.

```ts
import BluetoothSdk, {DeviceModels} from "@mentra/bluetooth-sdk"

const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  timeoutMs: 10_000,
  onResults: (nextDevices) => {
    console.log("Nearby glasses:", nextDevices)
  },
  onDiagnostic: (hint) => showScanHint(hint.message),
})

const device = await chooseDevice(devices)
if (!device) {
  throw new Error("No Mentra Live glasses selected")
}

await BluetoothSdk.connect(device)
const versionInfo = await BluetoothSdk.requestVersionInfo()
console.log(versionInfo.buildNumber)
```

`onDiagnostic` optionally reports a matching phone connection after an empty scan
on Android and iOS. It is advisory, does not identify another app, and leaves
normal empty completion unchanged. React hooks expose it as `scan.diagnostic`
on `useMentraBluetooth()`, or `diagnostic` on `useBluetoothScan()`. Clear the hint
when retrying or connecting.

On iOS, Mentra Live connections require Apple Notification Center Service
(ANCS) authorization by default. Apps that do not use notification relay can
skip that system authorization requirement for a connection:

```ts
await BluetoothSdk.connect(device, {requiresAncs: false})
```

The option defaults to `true` for backward compatibility and is an intentional
no-op on Android.

In multi-device environments, present an explicit picker instead of
auto-connecting to the first nearby device.

Mentra Live does not have a display. Use display commands only after gating by
model capability.

Use `Device.id` as the stable app-facing key for scan rows, selected devices,
and persisted default devices. Do not parse it for model, name, or address
information; use the typed `model`, `name`, `address`, and `rssi` fields
instead. Android commonly uses a Bluetooth address when available, iOS commonly
uses a CoreBluetooth identifier when available, and the SDK falls back to
`model:name` when no platform identifier is available.

`Device.rssi` is optional. A device can appear in scan results before the
platform reports RSSI, so picker UI should handle `undefined` and avoid
reordering rows just because RSSI metadata arrives later.

## Mentra SDK Usage Analytics

The SDK sends three usage events to Mentra's PostHog project by default so
Mentra can understand SDK adoption, successful glasses connections, and
enterprise device deployments:

- `bluetooth_sdk_started`: sent once per app runtime after the native SDK starts.
- `bluetooth_sdk_glasses_connected`: sent when SDK status transitions from not connected to connected.
- `bluetooth_sdk_glasses_identified`: sent once per connection after the SDK receives a valid manufacturing serial from the glasses, and again as a `glasses_heartbeat` on the first status update of each new reporting day (`America/Los_Angeles` calendar day, the calendar Mentra's weekly reporting is cut on) while that connection is still up, so a connection that spans a week boundary is visible in both weeks. Heartbeats ride on glasses status updates; a connection whose status never changes for a whole day produces none. This fires for every supported model that reports a serial. G1, G2, and Ar99 decode the serial from the glasses' BLE advertisement. Mentra Live reports the product serial provisioned by its Android firmware through `asg_client`.

The connected event waits for the glasses model when the model is not known at
the moment the connection flag flips; if the connection ends first it is sent
without a model and with `glasses_model_unresolved=true`.

Analytics delivery never blocks Bluetooth SDK behavior: events are submitted
asynchronously off the caller thread. An upload that fails (no network, non-2xx)
is kept in a small on-device queue (at most 100 events, 7 days) and retried on
the next successful send or the next SDK start; a payload PostHog rejects
outright (4xx other than 408/429) is dropped rather than retried. Each event
carries its own `uuid` and capture `timestamp`, so a retry neither double counts
nor moves the event to a later week.

React Native / Expo apps can disable these events before SDK startup through
the config plugin:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "analytics": false
        }
      ]
    ]
  }
}
```

Native Android apps can pass `BluetoothSdkAnalyticsConfig.disabled()` in
`MentraBluetoothSdkConfig` or add
`com.mentra.bluetoothsdk.analytics.disabled=true` as application metadata.
Native iOS apps can pass `.disabled` in `MentraBluetoothSDKConfiguration` or set
`MentraBluetoothSdkAnalyticsDisabled` to `true` in `Info.plist`.

Hosts that ship the same package id through several lanes (dev, staging, store)
can label the lane so Mentra can separate them. Pass
`{"analytics": {"environment": "prod"}}` to the config plugin, or set the
`com.mentra.bluetoothsdk.analytics.environment` Android metadata /
`MentraBluetoothSdkAnalyticsEnvironment` `Info.plist` key directly. Values are
trimmed and lowercased, must start with a letter or digit, may then contain
`[a-z0-9_-]`, are at most 32 characters, and are reported as `app_environment`.

Mentra counts an install as production only when `app_install_source` is
`app_store` or `play_store`, `app_build_type` is `release`, and, for hosts that
declare a lane, `app_environment` is `prod`. Play cannot distinguish its testing
tracks from production (both report `play_store`), so the lane is what separates
them for the Mentra App; hosts without a lane are reported as an unclassified
store cohort rather than assumed production.

Mentra's PostHog project API key is embedded in the SDK as a public analytics
write token, not a private PostHog personal API key. Apps do not configure the
analytics destination; these SDK usage events are always sent to Mentra's
PostHog project unless analytics are disabled.

Captured properties include `event_source`, `sdk_platform`, `sdk_surface`,
`sdk_version`, `app_identifier` (the Android package or iOS bundle identifier),
the platform-specific `app_package` or `app_bundle_identifier`, OS
platform/version, and `event_kind`. Every event also carries host build facts:
`app_version`, `app_build`, `app_build_type` (`debug` / `release`),
`app_install_source` (`play_store`, `app_store`, `testflight`, `adhoc_or_dev`,
`simulator`, `sideload`, a named third-party store, `other_store`, or `unknown`
when the platform gave no usable evidence), the raw Android
`app_installer_package` when present, and `app_environment` when the host
declares one. Connection and identification events include `fully_booted`,
a glasses model value when known, and `glasses_is_simulated`. The identification
event intentionally includes the glasses manufacturing serial as
`glasses_device_id`, with `glasses_device_id_type=manufacturing_serial`, so
Mentra can correlate fleet deployments across supported models, plus the
glasses-side software versions the SDK already holds (`glasses_firmware_version`,
`glasses_bes_firmware_version`, `glasses_mtk_firmware_version`,
`glasses_android_version`, `glasses_app_version`, `glasses_build_number`) so
identified glasses can be grouped by firmware. Glasses that never report a
serial produce no identification event; that coverage gap is measured as
connections without identification per model and SDK version, not from these
fields. This serial identifies the glasses
hardware, not the user or the host phone. Its source depends on the model:
Mentra Live reports the serial provisioned in BES NV storage, while G1 and Ar99
decode it from the glasses' BLE advertisement / manufacturer data.

Apart from that glasses serial, the SDK does not upload BLE MAC addresses,
CoreBluetooth identifiers, the host phone's Android device serial, Bluetooth
device names, user ids, tokens, Wi-Fi credentials, microphone data, photos, or
transcripts. PostHog receives a locally generated anonymous SDK install id as
`distinct_id`, and events include `$process_person_profile: false`.

## React Hooks

React Native apps can import optional lifecycle helpers from the `react`
subpath for common lifecycle plumbing. Use the root `BluetoothSdk` object for
commands such as `requestPhoto()`, `startStream()`, and `setMicState()`.

```tsx
import {Button, Text, View} from "react-native"
import {DeviceModels} from "@mentra/bluetooth-sdk"
import {useBluetoothEvent, useMentraBluetooth} from "@mentra/bluetooth-sdk/react"

export function DeviceScreen() {
  const mentra = useMentraBluetooth({
    defaultModel: DeviceModels.MentraLive,
    scanTimeoutMs: 10_000,
  })

  useBluetoothEvent("button_press", (event) => {
    console.log("Glasses button:", event.buttonId, event.pressType)
  })

  return (
    <View>
      <Text>{mentra.glasses.connected ? "Connected" : "Disconnected"}</Text>
      <Button disabled={mentra.busy} title="Scan" onPress={() => mentra.scan.start()} />
      {mentra.scan.devices.map((device) => (
        <Button key={device.id} title={device.name} onPress={() => mentra.connect(device)} />
      ))}
      <Button disabled={!mentra.glasses.connected} title="Disconnect" onPress={mentra.disconnect} />
    </View>
  )
}
```

The hooks do not request Android permissions or choose a persistence package for
you. Ask for permissions in your app before calling scan/connect actions, and
pass a `defaultDeviceStorage` adapter to `useMentraBluetooth` if you want a
default device to survive app restarts.

Use `useMentraBluetooth()` as the React status API for connection, battery,
Wi-Fi, hotspot, scan, and SDK runtime state.

The React hook exposes `glasses.connection` as a discriminated union:

```ts
type GlassesConnectionStatus =
  | {state: "disconnected"}
  | {state: "scanning"}
  | {state: "connecting"}
  | {state: "bonding"}
  | {state: "connected"; fullyBooted: boolean}
```

Use `connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`. Android and iOS native APIs also keep `connectionState`, `connected`, and `fullyBooted` as native status properties for Kotlin and Swift callers.

## Default Device

`connectDefault()` connects to the default glasses target stored in SDK state. Apps that want this target to survive app restarts should persist the scanned `Device` in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

```ts
const savedDevice = await loadSavedDeviceFromYourAppStorage()
if (savedDevice) {
  await BluetoothSdk.setDefaultDevice(savedDevice)
  await BluetoothSdk.connectDefault()
}

const discoveredDevice = await scanAndChooseDevice()
await BluetoothSdk.connect(discoveredDevice)
await saveDeviceToYourAppStorage(discoveredDevice)

await BluetoothSdk.clearDefaultDevice()
await saveDeviceToYourAppStorage(null)
```

## Native notification controls

G2 exposes firmware-owned notification history and popups. `getNativeNotificationStatus()` reports support, source (`phone` on Android or `ancs` on iOS), authorization, the desired controls, and submission/failure state. `submitted` means the controls were queued for the glasses, not that firmware acknowledged them. Unsupported drivers reject configuration instead of silently succeeding.

```ts
await BluetoothSdk.configureNativeNotifications({
  enabled: true,
  autoDisplay: true,       // false keeps history without automatic popups
  durationSeconds: 5,     // 1–30
  doNotDisturb: false,
  blockedApps: [],        // Android package names; iOS requires an empty list
})
const status = await BluetoothSdk.getNativeNotificationStatus()
const subscription = BluetoothSdk.addListener('native_notification_status', handleStatus)
```

The native SDKs expose the same configuration/status methods and `NativeNotificationConfig` type. Engine hosts should use the shared `engine.phoneNotifications` presentation policy and settings rather than competing with it through direct SDK configuration.

Android content uploads use the existing phone listener and a bounded G2 file-transfer queue. `native_notification_delivery` reports delivered, failed, cancelled, or dropped notifications by id without their content. Delivered means all three file phases acknowledged success. Disable, settings changes, and disconnect invalidate pending work. An interrupted or timed-out upload requires reconnect before another upload because the verified ACK format has no transaction id.

iOS G2 receives notifications directly through ANCS. Authorization is reported from the connected accessory and controls are reapplied after reconnect or authorization changes. No iOS content upload or full title/body relay is exposed. iOS keeps the firmware's existing app filter and rejects a nonempty `blockedApps` list. Phone dismissals are not yet synchronized to G2 history; the verified protocol does not establish a removal command.

## Common Commands

```ts
await BluetoothSdk.clearDisplay()
await BluetoothSdk.showDashboard()
await BluetoothSdk.setDashboardPosition(4, 2)

const networks = await BluetoothSdk.requestWifiScan()
console.log(networks.map((network) => network.ssid))

const savedResult = await BluetoothSdk.getSavedWifiNetworks()
if (savedResult.outcome === "confirmed") console.log(savedResult.networks)

const wifiStatus = await BluetoothSdk.sendWifiCredentials("Office WiFi", "secret")
console.log(wifiStatus.state)

const forgetResult = await BluetoothSdk.forgetWifiNetwork("Office WiFi")
console.log(forgetResult.outcome)

const hotspotStatus = await BluetoothSdk.setHotspotState(true)
console.log(hotspotStatus.state)

await BluetoothSdk.setWifiAdbState(true) // Mentra Live Wi-Fi ADB (wireless debugging)

const galleryAck = await BluetoothSdk.setGalleryModeEnabled(true)
console.log(galleryAck.status)
await BluetoothSdk.setGalleryModeEnabled(false)

await BluetoothSdk.setPreferredMic("auto")
await BluetoothSdk.setMicState(true)
await BluetoothSdk.setOwnAppAudioPlaying(false)

const ledAck = await BluetoothSdk.rgbLedControl(`led-${Date.now()}`, "com.example.app", "on", "green", 500, 500, 3)
console.log(ledAck.state)
```

## Dashboard Content

`setDashboardContent(content)` keeps the standard `$TIME12$ $DATE$ $GBATT$
$CONNECTION_STATUS$` status header and places non-empty content below it after a
blank line. Pass the exact empty string to reset the dashboard to the status
header only. The template is held in memory for the SDK process/session, and its
status placeholders are refreshed each time the dashboard renders. Calling this
method does not open the dashboard; it updates an active contextual dashboard
immediately or appears on the next head-up. Repeating the same content is a
no-op.

React Native / Expo:

```ts
await BluetoothSdk.setDashboardContent('Next meeting at 2 PM')
await BluetoothSdk.setDashboardContent('')
```

Kotlin:

```kotlin
sdk.setDashboardContent("Next meeting at 2 PM")
sdk.setDashboardContent("")
```

Swift (iOS and macOS):

```swift
await sdk.setDashboardContent("Next meeting at 2 PM")
await sdk.setDashboardContent("")
```

Settings commands that return `SettingsAckSuccessEvent` reject when the ASG reports an error ack. The SDK updates its local settings store only after that ASG ack resolves successfully, so observed SDK state reflects the acknowledged glasses state rather than a queued request. Raw `settings_ack` listener events still use `SettingsAckEvent` because they can include both success and failure statuses. `rgbLedControl(...)` resolves from a successful ASG `rgb_led_control_response` and rejects when the ASG reports `state: "error"`; raw `settings_ack` and `rgb_led_control_response` events remain available through listeners.

WiFi, hotspot, and version-info commands resolve from the ASG response path, not local dispatch:
`requestWifiScan()` resolves from the ASG `wifi_scan_result` completion response with the updated scan list, including `[]` when no networks are found. Intermediate `wifi_scan_result` events can arrive with `scanComplete: false` while the glasses stream discovered networks; the final event uses `scanComplete: true`. If older glasses stream non-empty scan results but never send the completion event, the request resolves with the accumulated scan list when the request times out. `sendWifiCredentials()` resolves when the requested SSID is connected, `forgetWifiNetwork()` returns a semantic `WifiForgetResult`, `getSavedWifiNetworks()` returns a semantic `SavedWifiNetworksResult`, `setHotspotState()` resolves when the requested hotspot state is reported, and `requestVersionInfo()` waits for all chunks declared by the correlated response's `chunkCount`, `chunkIndex`, and `final` metadata. Legacy single-message responses complete immediately; legacy chunked responses complete on `version_info_3` after `version_info_1`. Missing final chunks time out rather than returning partial data after a quiet period.

Current Mentra Live builds advertise `wifiForgetResultVersion` and `savedWifiNetworksVersion` in `version_info_1`. Native queues calls while those capabilities are unknown, sharing one 15-second deadline for negotiation and response. A discovery timeout rejects and never guesses that the glasses are legacy. Only version 1 is supported: modern commands carry `protocolVersion: 1`, a nonempty request ID, and the glasses process session ID; legacy forget commands omit all three fields. Unknown or malformed versions fail closed. Correlated results must match the complete tuple and (for forget) exact SSID; unrelated `wifi_status` events never settle a modern request. Session changes and disconnects reject pending WiFi work instead of allowing stale responses to cross sessions.

`WifiForgetResult.outcome` is `confirmed`, `dispatched`, `not_found`, `unsupported`, `failed`, or `legacy_unverified`. K900 returns `dispatched`: ASG queued its asynchronous SystemUI broadcast, but the vendor API provides no completion callback and credential removal is not verified. `connected`, `currentSsid`, and `localIp` are best-effort diagnostic snapshot fields; `connected` is omitted when ASG cannot read the link state and must not be interpreted as `false`. Older firmware without the capability advertisement uses the isolated legacy path; accepted native dispatch immediately returns `legacy_unverified`, with no invented link-state snapshot. `getSavedWifiNetworks()` preserves exact SSID identity. It returns `confirmed` only for a backend with reliable enumeration, while K900 and legacy firmware return a typed `unsupported` result because the vendor credential store has no reliable list response.

Promise results expose semantic outcomes and optional link snapshots, not `mode`, `capabilityVersion`, `requestId`, or `sid`. A legacy result returns `legacy_unverified` immediately after actual native transport acceptance; no active or compatible glasses transport rejects with `dispatch_failed`.

Raw `wifi_forget_result` listeners receive a discriminated event union. `mode: "modern"` carries `requestId`, `sid`, `protocolVersion`, and semantic `outcome`; `mode: "legacy"` preserves the older uncorrelated wire frame's `dispatched` boolean. Partial tuples are rejected. Terminal Wi-Fi events use at-least-once BLE delivery, so raw listeners can observe retries; deduplicate modern events by `(requestId, sid)`. Promise coordinators accept only the first matching terminal frame.

The SDK automatically sends the phone wall clock once shortly after a glasses connection becomes ready. It waits for the initial command burst to drain before timestamping the command so startup queue delay does not become clock skew. The once-per-connection guard resets after disconnect, so every successful reconnect synchronizes again. The SDK does not periodically verify or correct clock skew during a long-lived connection; apps that require periodic reconciliation can compare `requestVersionInfo().systemTimeMs` with the phone clock.

React Native narrows returned values to success shapes where the raw listener event can also report errors:

| API | Returned Value After `await` | Error Path |
| --- | --- | --- |
| `requestPhoto(...)` | Terminal `PhotoSuccessResponseEvent` with `state: "success"` after capture and delivery finish. `uploadUrl` is always present; webhook JSON metadata such as `photoUrl`, `statusUrl`, `contentType`, or `fileSizeBytes` is included when the receiver returns it. | Rejects when raw `photo_response.state === "error"`, the SDK cannot send the command, or the terminal photo response times out. |
| `startVideoRecording(...)` | `VideoRecordingStartedStatusEvent` with `success: true` and `status: "recording_started"`. | Rejects on `success: false` statuses such as `already_recording`, send failure, or timeout. |
| `stopVideoRecording(...)` | `VideoRecordingStoppedStatusEvent` with `success: true` and `status: "recording_stopped"`. When a webhook URL is supplied, resolves after the video upload succeeds. | Rejects on `success: false` statuses such as `not_recording`, webhook upload failure, send failure, or timeout. |
| `queryVideoRecordingStatus(requestId)` | `VideoRecordingStatusEvent` with the current `recording` state and elapsed `duration_ms` when available. | Rejects when disconnected, another video command uses the same request ID, or the response times out. |
| `rgbLedControl(...)` | `RgbLedControlSuccessResponseEvent` with `state: "success"`. | Rejects when raw `rgb_led_control_response.state === "error"` or the response times out. |
| `checkForOtaUpdate()` | `boolean`, true when the configured OTA manifest has an ASG APK, MTK, or BES update for the connected glasses; false only when the manifest was checked successfully and no update is available. | Rejects when the glasses are disconnected, version info is unavailable, the glasses report an unofficial client package (`unofficial_client`), the manifest cannot be fetched, or the manifest response is invalid/missing required ASG app version fields. |

Android and iOS async APIs use `BluetoothSdkException` / `BluetoothSdkError` for the same error paths. Their returned event structs are the successful response in normal `try`/`await` code, while raw listener/delegate events still include both success and error payloads.

`setMicState(true)` defaults to continuous microphone PCM from the glasses. The SDK does not apply phone-side Voice Activity Detection gating to microphone audio events. Glasses-side Voice Activity Detection is disabled by default for public SDK consumers; use `setVoiceActivityDetectionEnabled(true)` when you want supported glasses to gate microphone audio and emit live speaking status. `voice_activity_detection_status` reports whether glasses-side Voice Activity Detection is enabled, and `speaking_status` reports speaking/not-speaking when supported. Microphone events include the latest `voiceActivityDetectionEnabled` value.

## OTA Updates

React Native apps should use `MentraLiveOtaFlow` or `useMentraLiveOta` from
`@mentra/engine/ota`. They provide the same tested Wi-Fi/hotspot,
APK/MTK/BES, restart, retry, and verification flow as the Mentra App. See
[Update Mentra Live](https://docs.mentraglass.com/bluetooth-sdk/software-update).

The Bluetooth SDK exposes the lower-level commands and transport capabilities
that Mentra Engine and native apps build on. They are not a replacement for the
Engine coordinator:

- `setOtaVersionUrl(url)` selects the manifest used by subsequent checks and installs. Use this
  for a customer-controlled internal update server.
- `getOtaVersionUrl()` returns the selected manifest, or the SDK-version-pinned Mentra manifest
  when no override was supplied.
- `checkForOtaUpdate()` fetches the configured manifest and resolves with `true` when an ASG APK, MTK, or BES update is available.
- `startOtaUpdate()` sends `ota_start` with the same configured manifest URL and resolves with the ASG start ack after your app presents the update and the user accepts it.
- `queryOtaStatus()` returns the correlated status for the active session.
- `@mentra/bluetooth-sdk/ota-transport` exposes scoped hotspot networking and
  the local OTA artifact server without exposing native module internals.

Release CI embeds an immutable manifest URL and checksum into every published
SDK distribution. The completed coordinated release record correlates the SDK
package with its exact manifest and OTA bundle. A completed release is available at
`https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v<releaseIdentity>`
and contains `mentra-release-<releaseIdentity>.json`, which records the exact
package coordinates, asset URLs, sizes, checksums, and build provenance.

Pre-wall-clock ASG builds that ignore `ota_start.ota_version_url` are checked
against the URL they advertise, or the production default if they do not
advertise one, so the app does not prompt for an update the glasses cannot
install.

Use these primitives directly only when implementing the documented native
Android/iOS OTA contract or infrastructure beneath a coordinator. React Native
application pages should render Mentra Engine's semantic controller state
instead of sequencing raw events.

Each coordinated prerelease publishes a portable OTA bundle. Stable releases
promote the exact beta-tested OTA bytes, so always resolve the bundle coordinate
and URL from `mentra-release-<releaseIdentity>.json` rather than constructing a
filename. The selected archive contains
`version.template.json`, every referenced ASG/MTK/BES artifact, `SHA256SUMS`,
and a dependency-free configuration script. After unpacking it, generate the
final manifest for its exact hosting URL:

```sh
node configure.mjs https://updates.example.internal/mentra-live/version.json
```

Host the entire directory at that location, then pass the same URL to `setOtaVersionUrl(...)`.
The generated `version.json` contains absolute internal artifact URLs, so it works with Mentra Live
ASG build 39 and newer as well as future firmware. Re-run the command if the hosted directory moves.

Firmware before ASG build 39 ignores `ota_start.ota_version_url` and must first be updated through
its legacy or factory-supported path. OTA remains host-driven: the SDK does not check or install
automatically.

OTA requires Mentra Live glasses firmware that supports the ASG OTA protocol and network access from the glasses. During install, normal BLE traffic can be interrupted and the glasses may restart; keep the app connected and avoid sending unrelated commands until `ota_status.status` is `complete` or `failed`.

Mentra Live also rejects `ota_start` before acknowledgement when its known battery level is below 5%, emitting a failed `ota_status` with `error_message: "battery_low"`. Unknown battery state remains fail-open, so apps should keep their own (typically stricter) user-facing battery policy.

## Photo Upload

```ts
const photo = await BluetoothSdk.requestPhoto({
  size: "medium",
  webhookUrl: "https://api.example.com/mentra/photo",
  authToken: "optional-token",
  compress: "medium",
  sound: true,
  exposureTimeNs: null, // auto exposure; pass a positive nanosecond value for manual exposure
  iso: null, // auto ISO; pass a positive ISO only with manual exposureTimeNs
})
console.log("photo delivered", photo.photoUrl ?? photo.uploadUrl, photo.fileSizeBytes)
```

`requestPhoto(...)` resolves only after the full photo action reaches terminal success: capture completed and the photo was delivered to the webhook, either directly from the glasses over Wi-Fi or through the phone's Bluetooth fallback relay. If you omit `requestId`, the SDK generates one and the terminal response includes it. It rejects if the ASG reports `state: "error"`, if phone-side fallback upload fails, if the SDK cannot send the command, or if no terminal `photo_response` arrives within 30 seconds. Photo requests use this longer operation-specific deadline because max-quality BLE fallback can legitimately exceed the 15-second deadline used by ordinary commands. Use `photo_status` for intermediate stages such as `accepted`, `configuring`, `capturing`, `captured`, `uploading`, `ble_fallback_compression`, `ready_for_transfer`, and `transferring`; `photo_status` is progress, while `photo_response` is terminal success/error. The raw `photo_response` event stream still includes both success and error events for subscribers. The webhook should accept multipart form data with a `photo` file and `requestId`. If `authToken` is provided, the uploader adds `Authorization: Bearer <token>`. The camera light is always enabled for photo capture.

For one-shot manual capture tuning, pass `exposureTimeNs` and `iso` together. `exposureTimeNs` is sensor exposure time in nanoseconds; `iso` is sensor ISO. If `exposureTimeNs` is omitted, `null`, invalid, or unsupported by the connected glasses, the camera uses auto exposure and ignores `iso`.

To own and explicitly release a warm camera, pass a request ID to `warmUpCamera({requestId, ...})`, then call `stopCameraWarmUp(requestId)` when the foreground UI closes. Warm holds default to 15 seconds and are capped at 60 seconds. Stopping while the camera is opening rejects the pending warm-up with `camera_warm_up_cancelled`; stopping after `ready` emits `stopped`. Compatible ready leases share the camera and expire independently.

Use `setCameraFov({fov, roiPosition})` to configure Mentra Live camera field of view and crop position. FOV is clamped to 62-118 degrees; ROI position is `"center"`, `"bottom"`, or `"top"`. You can also call `setCameraFov({preset: "narrow" | "standard" | "wide"})`; presets map to 82, 102, and 118 degrees with center ROI. The returned `CameraFovResult` resolves only after the ASG client reports that the setting was applied to camera hardware after the restart cooldown, and the promise rejects if the glasses report an error, persist the setting without hardware application, or time out. Raw `settings_ack` events remain available through `addListener("settings_ack", ...)` for diagnostic fields such as `hardwareApplied`. Treat FOV as a framing/ROI control; output resolution and effective detail can vary by capture path, firmware, and camera mode.

The missing/factory persistent FOV base is 102 degrees with centered ROI; existing saved values are not migrated. Use `setCameraFovOverride({leaseId, fov, roiPosition, ttlMs})` for a memory-only crop and `releaseCameraFovOverride(leaseId)` to restore the persistent base. A stale release is a safe no-op, and refreshing the same lease/config extends its TTL without another HAL restart.

`startVideoRecording(...)` resolves from the ASG `video_recording_status` event whose status is `recording_started`. `stopVideoRecording(...)` without a webhook resolves from `recording_stopped`; with a webhook it waits for `recording_stopped` plus a video `media_success`, and rejects on `media_error`. Use `queryVideoRecordingStatus(requestId)` after a timeout, reconnect, or app resume to fetch the glasses' current `recording` state and elapsed `duration_ms`. Raw `video_recording_status`, `media_success`, and `media_error` events remain available through listeners.

## Streaming

```ts
const streamId = `stream-${Date.now()}`

await BluetoothSdk.startStream({
  type: "start_stream",
  streamUrl: "http://192.168.1.42:8889/mentra-live/whip",
  streamId,
  video: {fps: 15},
})

await BluetoothSdk.stopStream()
```

Use `rtmp://` or `rtmps://` for RTMP, `srt://` for SRT, and `http://` or `https://` for WHIP/WebRTC ingest. `startStream()` resolves with the correlated `stream_status` event once the glasses report `status: "streaming"`; `stopStream()` resolves when the glasses report `status: "stopped"` or confirms the stream was already stopped / not streaming. `stopStream()` returns a normalized stopped event for that already-stopped case. Stream starts reject if the glasses report an error before streaming; stream stops reject for real stop errors, send failure, another stop in flight, or timeout. Stream video input fields are `width`, `height`, `bitrate`, and `fps`. The SDK sends stream keep-alives automatically while streaming and reports keep-alive failures through `stream_status`. The camera light is always enabled while streaming.
`stream_status` events may include `resolvedConfig`, which reports the effective transport, video, and audio settings after glasses defaults, clamps, and camera preflight. The resolved effective frame rate is reported as `resolvedConfig.video.fps`. While live, supported firmware emits periodic `streaming` events whose `stats` object contains `bitrate` (bits per second), `fps`, `droppedFrames`, `duration` (seconds), and `temperatureC` when the CPU sensor is available.

## Events

React Native components should use `useBluetoothEvent()` for hardware events:

```tsx
import {useBluetoothEvent} from "@mentra/bluetooth-sdk/react"

export function HardwareEventLogger() {
  useBluetoothEvent("button_press", (event) => console.log(event))
  useBluetoothEvent("touch_event", (event) => console.log(event))
  useBluetoothEvent("photo_status", (event) => console.log(event.status, event.resolvedConfig, event.captureMetadata))
  useBluetoothEvent("stream_status", (event) => console.log(event))
  useBluetoothEvent("speaking_status", (event) => console.log(event.speaking))
  useBluetoothEvent("mic_pcm", (event) => {
    console.log(event.sampleRate, event.bitsPerSample, event.channels, event.encoding)
    console.log(event.pcm)
  })
  useBluetoothEvent("mic_health", (event) => {
    console.log(event.reason, event.sequenceGapEvents, event.decodeFailures)
  })

  return null
}
```

For non-React modules, `BluetoothSdk.addListener(...)` is the low-level subscription API. Keep the returned subscription and call `remove()` when the listener is no longer needed.

Common event names include `button_press`, `touch_event`, `head_up`, `battery_status`, `wifi_status_change`, `wifi_scan_result`, `hotspot_status_change`, `photo_status`, `photo_response`, `gallery_status`, `settings_ack`, `version_info`, `stream_status`, `ota_start_ack`, `ota_status`, `mic_pcm`, `mic_lc3`, `mic_health`, `local_transcription`, `rgb_led_control_response`, `audio_connected`, `audio_disconnected`, and `log`.

React Native event payload fields usually use camelCase. OTA events intentionally mirror the glasses firmware field names, such as `overall_percent` and `version_name`. For example, `touch_event` includes `gestureName`, `wifi_scan_result` includes `networks` and `scanComplete`, `version_info` matches the `requestVersionInfo()` result shape, `photo_response` success includes `uploadUrl` and may include webhook-returned `photoUrl`, `statusUrl`, `contentType`, and `fileSizeBytes`, and `gallery_status` includes `hasContent`, `cameraBusy`, and optional `cameraBusyReason`. `photo_status` reports intermediate photo states such as `accepted`, `queued`, `configuring`, `capturing`, `captured`, `compressing`, `ble_fallback_compression`, `uploading`, `ready_for_transfer`, `transferring`, and `failed`; the `configuring` event includes `resolvedConfig` with the effective JPEG dimensions, quality, requested size, transfer method, compression, and manual exposure fields when present. The `capturing` event may include `requestedCaptureConfig` and `meteredPreview`; the `captured` event may include `captureMetadata` with the HAL-applied exposure, ISO, frame duration, and AE state. `mic_pcm` includes `sampleRate`, `bitsPerSample`, `channels`, and `encoding`; `mic_lc3` includes `sampleRate`, `channels`, `encoding`, `frameDurationMs`, `frameSizeBytes`, `bitrate`, and `packetizedFromGlasses`.

`mic_health` emits a snapshot when native code detects a glasses LC3 `sequence_gap` or `decode_failure`. Each event includes cumulative `sequenceGapEvents` and `decodeFailures` counters for the current connection plus `lastLc3ReceivedAt`, `lastPcmProducedAt`, and `timestamp` in Unix milliseconds when available. These failures occur before React Native receives PCM and cannot be reconstructed from `mic_pcm` alone. The existing `mic_pcm` and `mic_lc3` streams remain unchanged.

Photo status metadata is tied to the capture stage where the glasses know it:

| Status | Optional metadata | Meaning |
| --- | --- | --- |
| `configuring` | `resolvedConfig` | Effective JPEG size, quality, requested size, source, transfer method, compression, and manual capture settings when present. |
| `capturing` | `requestedCaptureConfig`, `meteredPreview` | Camera2 still request about to be submitted, plus the latest auto-exposure preview estimate before capture. |
| `captured` | `captureMetadata` | HAL-applied still capture result, including actual exposure, ISO, frame duration, AE state, and related camera modes when available. |

Upload and transfer statuses such as `uploading`, `compressing`, `ble_fallback_compression`, `ready_for_transfer`, and `transferring` describe transport progress only and do not carry capture metadata. `ble_fallback_compression` means the direct Wi-Fi/webhook upload failed and the glasses are compressing the already-captured photo for Bluetooth fallback delivery. Local action-button photos emitted by the glasses use the same `photo_status` event shape when the phone SDK is connected; those events use `resolvedConfig.source: "button"` and `resolvedConfig.transferMethod: "local"`.

Only documented imports are supported for app developers. Undocumented package subpaths or symbols with a leading underscore can change without notice.

## Local SDK Development

For normal app development, install the JavaScript package from npm. For SDK source development or release testing, install a local checkout and point Metro/native resolution at the same path:

```sh
bun add --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bunx expo run:ios
```

Use `bunx expo run:android` for Android. Keep local paths in your shell or CI environment, not in committed app config.

For local Android source compile checks inside this monorepo, run from the
MentraOS repo root:

```sh
./scripts/check-android-compile.sh bluetooth-sdk
```

The `android/` folder in this package is source for the generated Expo Android
project, not the local Gradle entrypoint. The check script prepares
`mobile/android` and uses its Gradle wrapper with `-PmentraPublicSdk=true`,
matching the CI release workflow's public SDK dependency mode.

For bare native iOS or macOS apps, use the public SwiftPM repository:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Select a coordinated SDK version that includes your target platform, then add
the `MentraBluetoothSDK` product to your app target. Native macOS support is new
on `dev`; use the local source override until a supporting release is published.

For local SDK development, add this package folder directly in Xcode:

```text
/path/to/MentraOS/mobile/modules/bluetooth-sdk
```

The core Swift package intentionally excludes optional local STT, Nex/SwiftProtobuf, Vuzix/Ultralite, and tar.bz2 extraction code paths.

Native Mac hosts need Bluetooth and local-network usage descriptions, and
sandbox entitlements for Bluetooth and outbound networking. Add microphone
permission/audio-input capability for host microphone capture and network-server
capability for local SDK servers. macOS uses CoreAudio instead of
`AVAudioSession`; it does not provide iOS background modes or ANCS relay. See
[the macOS integration guide](../../../mintlify-docs/bluetooth-sdk/macos.mdx)
and the Starter Kit's `examples/macos` and `examples/react-native-macos` hosts.

Maintainers publishing the public SwiftPM mirror should follow
[RELEASING_IOS_SPM.md](./RELEASING_IOS_SPM.md).

## Android Maven Publishing

Maintainers publishing the native Android artifacts to Maven Central should
follow [RELEASING_ANDROID_MAVEN.md](./RELEASING_ANDROID_MAVEN.md).

Public Maven publishing uses a public SDK mode that omits MentraOS-only Android
integrations from the artifact metadata while normal MentraOS app builds keep
those integrations enabled.

Use `android/gradle.properties.example` as the template for Sonatype Central and
GPG signing properties. Put real values in `~/.gradle/gradle.properties` or CI
secrets, not in the repository.

## Starter Example App

The [Mentra Bluetooth SDK Starter Kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit) includes starter example apps for Android, iOS, and React Native / Expo. The React Native starter demonstrates scan/connect, display, camera photo upload, RTMP/SRT/WebRTC streaming, Wi-Fi/hotspot, microphone PCM, RGB LED, gallery mode, and console event inspection.
