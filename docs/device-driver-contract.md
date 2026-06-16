# Device-driver contract (GlassesDriver / DeviceHost / DeviceCapabilities)

Status: **proposed contract** (interface design; first implementation in progress)
Companion to: `docs/pluggable-device-drivers-oem-sdk.md`,
`docs/device-driver-architecture-explainer.md`

This is the precise, method-by-method contract a driver author implements,
derived from the real `SGCManager` surface
(`modules/bluetooth-sdk/{android,ios}/.../sgcs/SGCManager.{kt,swift}`). Signatures
are shown Kotlin-flavored (the Android build target); the Swift mirror is
1:1. **No member is invented** — every line below maps to an existing
`SGCManager` member or an existing call drivers already make into the app
(see the mapping table in §6).

## 1. The three buckets

Every member of today's `SGCManager` is one of:

1. **Inbound command** the app calls on the driver → goes in **`GlassesDriver`**
   (the public interface the OEM implements). Gated by capabilities.
2. **Callback** the driver makes back into the app (today via the `Bridge`,
   `DeviceStore`, `DeviceManager` singletons) → goes in **`DeviceHost`** (the
   handle we inject into the driver). The driver no longer touches our
   singletons directly.
3. **Internal / adapter-handled** — debug hooks, defaulted no-ops, and
   app-internal bookkeeping that an OEM shouldn't see → kept out of the public
   contract; the in-repo **adapter** (§5) supplies them.

## 2. DeviceCapabilities

Declared once at registration; the app uses it to (a) gate which `GlassesDriver`
methods are ever called and (b) drive feature-gating
(`getModelCapabilities`). Replaces today's `hasMic` boolean + the hardcoded
`HARDWARE_CAPABILITIES` map.

```kotlin
data class DeviceCapabilities(
  val hasDisplay: Boolean = false,
  val displayKind: DisplayKind = DisplayKind.NONE,      // NONE | MONOCHROME | GRAYSCALE | COLOR
  val displayGeometry: DisplayGeometry? = null,         // widthPx, heightPx (for layout + the lens mirror)
  val hasMic: Boolean = false,
  val hasCamera: Boolean = false,
  val hasSpeaker: Boolean = false,
  val hasImu: Boolean = false,
  val hasWifi: Boolean = false,
  val buttons: List<String> = emptyList(),
  val hasTouchpad: Boolean = false,
)
```

## 3. GlassesDriver (what the OEM implements)

The public, versioned inbound surface. Grouped by capability; a group is only
called when the matching capability is declared. Trimmed from `SGCManager`'s ~60
members down to what an external driver actually needs (see §6 for what was
dropped and why).

```kotlin
interface GlassesDriver {
  val capabilities: DeviceCapabilities

  // ---- lifecycle ----
  fun connect(id: String)                 // was connectById
  fun disconnect()
  fun forget()
  fun cleanup()
  fun ping()
  fun getConnectedName(): String?         // was getConnectedBluetoothName
  fun requestВ ersionInfo() {}             // optional; default no-op

  // ---- display (only if capabilities.hasDisplay) ----
  suspend fun showText(text: String)                              // sendTextWall
  suspend fun showDoubleText(top: String, bottom: String)         // sendDoubleTextWall
  suspend fun showBitmap(image: ImageData, rect: Rect?): Boolean  // displayBitmap
  fun clearDisplay()
  fun setBrightness(level: Int, auto: Boolean)
  // dashboard (optional; default no-op for non-Even devices)
  fun showDashboard() {}
  fun setDashboardPosition(height: Int, depth: Int) {}

  // ---- audio (only if capabilities.hasMic) ----
  fun setMicEnabled(on: Boolean)
  fun sortMicRanking(list: List<String>): List<String> = list     // default identity

  // ---- camera / media (only if capabilities.hasCamera) ----
  fun requestPhoto(req: PhotoRequest) {}
  fun startStream(cfg: StreamConfig) {}
  fun stopStream() {}
  fun sendStreamKeepAlive(cfg: StreamConfig) {}
  fun startVideoRecording(req: VideoRequest) {}
  fun stopVideoRecording(requestId: String) {}

  // ---- sensors / control ----
  suspend fun setImuEnabled(on: Boolean) {}                       // only if hasImu
  fun setHeadUpAngle(angle: Int) {}
  fun getBatteryStatus()
  fun setSilentMode(on: Boolean) {}
  fun sendShutdown() {}
  fun sendReboot() {}
  fun sendRgbLedControl(req: RgbLedRequest) {}

  // ---- network (only if capabilities.hasWifi) ----
  fun requestWifiScan() {}
  fun sendWifiCredentials(ssid: String, password: String) {}
  fun forgetWifiNetwork(ssid: String) {}
  fun sendHotspotState(on: Boolean) {}

  // ---- scanning (find devices to connect to) ----
  fun findCompatibleDevices()
  fun stopScan()
}
```

(`requestВersionInfo` typo above is illustrative-only — real name
`requestVersionInfo`.)

`ControllerDriver` is the same shape minus display/camera, plus
`connectController`-style lifecycle — see §7.

## 4. DeviceHost (what we inject into the driver)

The narrow façade the driver calls **instead of** `Bridge`, `DeviceStore`, and
`DeviceManager`. Every method here corresponds to a real call `RemoteHarness`
already makes (§6). This is the entire surface an OEM driver may touch — nothing
else about the app leaks in.

```kotlin
interface DeviceHost {
  // connection state  (was DeviceStore.apply("glasses", "connected"/"connectionState"/"fullyBooted"))
  fun reportConnectionState(state: ConnectionState)   // CONNECTING | CONNECTED | DISCONNECTED
  fun reportReady(ready: Boolean)

  // device identity / info  (was DeviceStore.apply("glasses", "deviceModel"/serial/fw/color...))
  fun reportDeviceInfo(info: DeviceInfo)              // model/family, serial, firmware, color, style

  // battery  (was DeviceStore battery/charging + Bridge.sendBatteryStatus)
  fun emitBattery(level: Int, charging: Boolean)

  // microphone  (was DeviceManager.getInstance().handleGlassesMicData)
  fun emitMicAudio(lc3: ByteArray, frameSize: Int)
  fun reportMicEnabled(on: Boolean)                   // was DeviceStore "micEnabled"

  // input / sensors  (was Bridge.sendTouchEvent / sendImuDataEvent)
  fun emitTouchEvent(gesture: String)
  fun emitImu(accel: FloatArray, gyro: FloatArray?, mag: FloatArray?, quat: FloatArray?, euler: FloatArray?)

  // camera results  (was the savePhoto path)
  fun savePhoto(bytes: ByteArray, meta: PhotoMeta)

  // command results  (was Bridge.sendRgbLedControlResponse, etc.)
  fun reportCommandResult(requestId: String, ok: Boolean, error: String?)

  // scanning  (was Bridge.sendDiscoveredDevice)
  fun reportDiscoveredDevice(id: String, name: String, rssi: Int?)

  // misc
  fun log(msg: String)
}
```

## 5. The adapter (how this plugs into today's app, unchanged)

We do **not** rewrite `DeviceManager`/`SGCManager`. Instead an in-repo adapter
makes a `GlassesDriver` look like an `SGCManager`:

```
DeviceManager  ──calls──>  SGCManager (interface unchanged)
                              ▲
                              │ implemented by
                    GlassesDriverSgcAdapter        ← in-repo glue
                       ├─ delegates inbound commands to  -> GlassesDriver
                       └─ provides a DeviceHostImpl that  -> Bridge / DeviceStore / DeviceManager
```

- `GlassesDriverSgcAdapter(driver, host)` implements every `SGCManager` member:
  - public ones → delegate to the `GlassesDriver` (e.g. `sendTextWall(t)` →
    `driver.showText(t)`), respecting capabilities;
  - internal/no-op ones (`dbg1`, `dbg2`, dashboard menu, calendar, OTA, gallery,
    `applyNexAudioPlaybackSetting`, …) → the adapter's own defaults;
  - `type`/`hasMic` → derived from `driver.capabilities`.
- `DeviceHostImpl` implements `DeviceHost` by calling the real singletons
  (`Bridge.*`, `DeviceStore.apply`, `DeviceManager.handleGlassesMicData`) — i.e.
  exactly what `RemoteHarness` does inline today, moved behind the façade.

So the migration is mechanical: `RemoteHarness` becomes a `GlassesDriver`, and
the adapter + `DeviceHostImpl` carry the singleton calls it used to make. The
rest of the app sees no change. Later, `DeviceManager.initSGC`'s `if/else` is
replaced by a registry that builds `GlassesDriverSgcAdapter(registered.driver,
DeviceHostImpl())` — but that's a separate step.

## 6. Mapping: every SGCManager member → where it goes

| SGCManager member | Destination |
|---|---|
| `setMicEnabled` | GlassesDriver.setMicEnabled |
| `sortMicRanking` | GlassesDriver.sortMicRanking (default identity) |
| `setBrightness` / `clearDisplay` / `sendTextWall` / `sendDoubleTextWall` / `displayBitmap` | GlassesDriver display group |
| `showDashboard` / `setDashboardPosition` / `setDashboardHeightOnly` / `setDashboardDepthOnly` / `setDashboardMenu` | GlassesDriver dashboard (default no-op) |
| `requestPhoto` / `startStream` / `stopStream` / `sendStreamKeepAlive` / `startVideoRecording`(x2) / `stopVideoRecording` | GlassesDriver camera group (gated hasCamera) |
| `sendButtonPhotoSettings` / `…VideoRecordingSettings` / `…MaxRecordingTime` / `…CameraLedSetting` / `sendCameraFovSetting` | adapter default no-op (camera button config; rarely OEM-relevant) |
| `setHeadUpAngle` / `setImuEnabled` / `getBatteryStatus` / `setSilentMode` / `sendShutdown` / `sendReboot` / `sendRgbLedControl` | GlassesDriver control group |
| `disconnect` / `forget` / `findCompatibleDevices` / `stopScan` / `connectById` / `getConnectedBluetoothName` / `cleanup` / `ping` / `requestVersionInfo` | GlassesDriver lifecycle |
| `requestWifiScan` / `sendWifiCredentials` / `forgetWifiNetwork` / `sendHotspotState` | GlassesDriver network (gated hasWifi) |
| `sendCalendarEvents` / `sendDashboardDisplaySettings` / `sendVoiceActivityDetectionSetting` / `applyNexAudioPlaybackSetting` / `sendSetSystemTime` / `queryGalleryStatus` / `sendGalleryMode` / `sendUserEmailToGlasses` / `sendIncidentId` | adapter default no-op (app/Even-specific bookkeeping) |
| `connectController` / `disconnectController` | controller path (see §7) |
| `exit` | adapter → maps to `clearDisplay` |
| `dbg1` / `dbg2` | dropped (internal debug) |
| `type` / `hasMic` properties | derived from `DeviceCapabilities` |
| — driver→app calls — | — |
| `Bridge.log` | DeviceHost.log |
| `Bridge.sendBatteryStatus` + `DeviceStore` battery/charging | DeviceHost.emitBattery |
| `Bridge.sendTouchEvent` | DeviceHost.emitTouchEvent |
| `Bridge.sendImuDataEvent` / `sendAccelEvent` | DeviceHost.emitImu |
| `DeviceManager.handleGlassesMicData` | DeviceHost.emitMicAudio |
| `Bridge.sendRgbLedControlResponse` | DeviceHost.reportCommandResult |
| `Bridge.sendDiscoveredDevice` | DeviceHost.reportDiscoveredDevice |
| `DeviceStore.apply("glasses", connected/connectionState/fullyBooted)` | DeviceHost.reportConnectionState / reportReady |
| `DeviceStore.apply("glasses", deviceModel/serial/firmware/color/style)` | DeviceHost.reportDeviceInfo |
| `DeviceStore.apply("glasses", micEnabled)` | DeviceHost.reportMicEnabled |

## 7. ControllerDriver

Same pattern, narrower. Controllers (e.g. the Even R1 ring) have no display or
camera; they emit input + battery and accept a little config.

```kotlin
interface ControllerDriver {
  val capabilities: ControllerCapabilities    // buttons, touchpad, hasImu, hasHaptics
  fun connect(id: String); fun disconnect(); fun cleanup(); fun ping()
  fun getBatteryStatus()
  // emits via the same DeviceHost: emitTouchEvent / emitImu / emitBattery / reportConnectionState
}
```
Registered with `kind: "controller"`; bridged by a `ControllerDriverAdapter`
onto the existing `ControllerManager`, mirroring §5.

## 8. Notes

- **Async/threading.** `showText`/`showBitmap`/`setImuEnabled` are `suspend`
  (they may do I/O). Everything is called on the main thread today; a driver
  doing blocking work must offload it (the lesson from `RemoteHarness`'s
  writer thread / NWConnection queue). `DeviceHost` methods are safe to call
  from any thread; the impl marshals to the main thread as needed.
- **Capabilities gate calls.** The adapter must not call display methods on a
  driver whose capabilities say `hasDisplay = false` (today the island silently
  drops them; the contract makes it explicit).
- **Versioning.** This contract is semver'd separately from the app
  (`docs/pluggable-device-drivers-oem-sdk.md` §8). The `SGCManager` internals
  can keep changing behind the adapter.

## 9. First implementation (proving the contract)

Target: refactor `RemoteHarness` (Android first) onto this contract with **zero
behavior change**, then verify e2e through the harness (emulator app → daemon →
real G2). Concretely:
1. Add `DeviceHost`, `DeviceCapabilities`, `GlassesDriver` (Kotlin).
2. Add `DeviceHostImpl` (wraps Bridge/DeviceStore/DeviceManager) +
   `GlassesDriverSgcAdapter` (wraps a GlassesDriver as an SGCManager).
3. Rewrite `RemoteHarness` as `RemoteHarnessDriver : GlassesDriver`; register it
   in `initSGC` via the adapter instead of directly.
4. Build Android, pair "Remote Glasses (Harness)", confirm text + mic/captions +
   bitmap still flow to the real G2 — same behavior, now through the contract.

This validates the contract against a real driver + real hardware before any of
the wider migration (registry, capabilities-from-registration, asset resolver).

### Status (2026-06-15): implemented + e2e-validated at the transport/command layer

Done on Android: `drivers/DeviceContract.kt` (GlassesDriver/DeviceHost/
DeviceCapabilities), `DeviceHostImpl`, `GlassesDriverSgcAdapter`,
`RemoteHarnessDriver`; `initSGC` routes REMOTE_HARNESS through
`GlassesDriverSgcAdapter(RemoteHarnessDriver(), DeviceHostImpl(...))`. Legacy
`sgcs/RemoteHarness.kt` left in place (unreferenced) as rollback.
`compileDebugKotlin` + full `installDebug` succeeded; app runs the new code.

E2E on the emulator (app → harness daemon): pairing "Remote Glasses (Harness)"
instantiated the NEW driver via the adapter, it opened the socket to the daemon
(`remote-sgc client connected`), and the app's on-connect display commands flowed
through the new path (`remote-sgc cmd: text` / `clear`) — confirming app →
`GlassesDriverSgcAdapter` → `RemoteHarnessDriver` → `DeviceHost`/socket → daemon
works end to end. The physical glasses-render + mic→captions legs still need the
G2 awake (it was asleep during this run); those exercise the same proven path.
