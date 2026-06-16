# Device-driver contract (SGCManager as the public adapter)

Status: **reconciled with CTO Phase 2 plan (authoritative direction below).**
Companion to: `docs/pluggable-device-drivers-oem-sdk.md`,
`docs/device-driver-architecture-explainer.md`

---

## 0. Authoritative direction (CTO Phase 2)

The contract an OEM implements **is the existing `SGCManager`**, made public and
conformable — not a second wrapper layer on top of it. There is one concept, not
two. The earlier `GlassesDriver` + `DeviceHost` + adapter design (appendix
sections below) was a useful exploration that proved the surface end-to-end on a
real G2, but it is **superseded** by this direction: a separate inbound interface
plus an injected outbound facade is the "second wrapper" we are explicitly
avoiding.

What we are building instead, in order:

1. **Public `SGCManager`.** Make the class public and conformable so a driver
   author subclasses (Kotlin) / conforms to (Swift) it directly. Renaming to
   `GlassesAdapter` is on the table but deferred — it touches ~52 call sites and
   buys nothing functionally, so it is a late, mechanical rename, not a blocker.

2. **`DeviceRegistry` keyed on a stable model ID.** A public
   `registerGlassesAdapter(modelId, capabilities, make: () -> SGCManager)`.
   Built-in SGCs (G1, G2, Live, Nex, Mach1/Z100, Simulated, Harness) register
   themselves as built-ins. `DeviceManager.initSGC` becomes a registry lookup
   instead of a hardcoded if/else. `DeviceTypes.ALL` opens so registered OEM
   models flow through discovery and capability resolution like first-party ones.

3. **Capability-flag dispatch (removes `as? MentraLive` downcasts).** Capabilities
   are injected at registration (reusing the existing capabilities shape, not a
   new `DeviceCapabilities` type). Today the app does `sgc as? MentraLive` to
   reach camera/OTA/speaker methods; instead those methods move onto `SGCManager`
   with default no-op/throw implementations and are gated by capability flags
   (`hasCamera`, `hasOta`, `hasSpeaker`). The call site checks the flag, never the
   concrete class. This is what lets an OEM device expose a camera without being
   a `MentraLive`.

4. **`onReady()` post-connect hook.** A single well-defined point that fires after
   the link is live and device info is known, so adapters do post-connect setup in
   one place instead of scattering it through connection callbacks.

5. **Open the `DeviceModel` enum** with `.oem` and `.unknown` cases. Fixes the
   `fromDeviceType` bug where unknown models silently defaulted to `.mentraLive`.

6. **Cloud-V2 runtime capabilities path** — cross-team dependency. The cloud must
   accept capabilities at runtime (from registration) rather than from a static
   per-model map, or OEM devices get mis-gated server-side. This gates true e2e
   for OEM models and is **not** ours alone to land; flagged as a dependency.

Scope and ownership notes:

- **Assets stay host-side / out of scope here.** OEMs build their own branded UI
  and register **no** images. Our `getGlassesImage` state+variant resolver
  (`mobile/src/utils/getGlassesImage.tsx`) stays a first-party concern; the
  AssetResolver idea from the OEM SDK draft is demoted to "host decides," not part
  of the adapter contract.
- **Registration is native-to-native.** No JS adapter shim; an OEM's native code
  registers against the native `SGCManager`/registry directly.
- **Discovery stays per-SGC.** Each adapter owns `findCompatibleDevices`; the
  registry does not centralize scanning.
- Optional later refinement (not now): a 2-layer `GlassesTransport` +
  `StandardGlassesProtocol` split, and default-impl versioning so adding a gated
  method to `SGCManager` does not break existing OEM builds. Tracked, not started.

Implementation status (this branch): the registry seam (item 2) is the first code
step; the `GlassesDriver`/`DeviceHost`/adapter files are being retired and
`RemoteHarness` returns to being a plain `SGCManager` registered through the
registry. Items 3-6 are scoped here and land incrementally with per-device
verification (item 6 blocked on the cloud team).

---

## Appendix (superseded): GlassesDriver / DeviceHost exploration

> The sections below document the earlier inbound-`GlassesDriver` +
> outbound-`DeviceHost` contract. They are retained because the method-by-method
> derivation from `SGCManager` (and the §6 mapping table) is still an accurate
> inventory of the real surface. The *split into two interfaces* is superseded by
> section 0; read the method inventory, ignore the wrapper shape.

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
works end to end. FULL hardware e2e then confirmed (2026-06-15, logged-in app + real G2 …3248):
the daemon connected the G2 (`link is live`) and the app pushed a display
command through the new driver the instant glasses connected
(`remote-sgc cmd: text` right after `link is live`) → rendered on the G2 lens.
So the complete chain — app → `GlassesDriverSgcAdapter` → `RemoteHarnessDriver`
→ `DeviceHost`/socket → daemon → G2 lens — is validated on real hardware,
behavior-identical to the legacy driver.

Gotcha hit during the run: macOS system Bluetooth auto-reconnects the bonded G2
arms and steals them from the daemon's CoreBluetooth scan (the daemon then
finds nothing). Fix: restart the daemon to release its handle, and/or "Forget"
the Even G2 in macOS Bluetooth settings so only the daemon holds it; the
daemon's /autoreconnect self-heals the periodic steal.
