# Pluggable Device Drivers — OEM SDK / extension point

Status: **design proposal** (no implementation yet)
Author: drafted with the agent-harness work as reference
Audience: MentraOS mobile/bluetooth-sdk maintainers + future hardware OEMs

## 1. Summary

Today, every supported pair of smart glasses (and every controller) is a
driver baked into the MentraOS repo and wired in through a hardcoded factory.
Adding a new device means forking the repo and editing core files. This
proposal turns the existing internal driver abstraction into a **public,
stable extension point** so a hardware OEM can build and ship their own device
driver **from their own codebase** — registering it into the library as an
adapter — without contributing to or forking the open-source core.

A registered device contributes three things, the last two optional:

1. **Driver** — the behavior (connect, display, mic, camera, sensors, …).
2. **Capabilities** — a declaration of what the hardware can do, which drives
   the app's feature-gating (which miniapps light up).
3. **Asset/branding pack** — optional images of the device the app shows in its
   UI (connected, searching, per-color/variant, in-case, …); falls back to a
   generic placeholder when absent.

The same shape applies to **controllers** (e.g. the Even R1 ring) via a
parallel registry.

## 2. Motivation

- **OEM onboarding without core changes.** OEMs may not want to (or be allowed
  to) contribute their driver to the open-source repo. They should be able to
  develop against a published toolkit/interface and plug their driver in.
- **Don't fork to extend.** Each new device today touches several core files
  (see §3). That is a merge-conflict and review bottleneck and does not scale
  to an open hardware ecosystem.
- **We already proved the abstraction works for non-built-in backends.** The
  dev-only `RemoteHarness` driver (added on the `agent-harness` branch) is an
  `SGCManager` that proxies over a TCP/JSON wire protocol to an out-of-process
  daemon holding real glasses. That is, in miniature, the "OEM ships a driver
  the core doesn't know about" pattern — see §7.

## 3. Current state (what would change)

The driver abstraction already exists; it is just internal and hardcoded.

- **The interface:** `SGCManager`
  - iOS: `mobile/modules/bluetooth-sdk/ios/Source/sgcs/SGCManager.swift`
    (`@MainActor protocol SGCManager`)
  - Android: `mobile/modules/bluetooth-sdk/android/.../sgcs/SGCManager.kt`
  - Concrete drivers: `G1`, `G2`, `MentraLive`, `MentraNex`, `Mach1`,
    `Simulated`, `RemoteHarness` (dev-only).
- **The hardcoded factory:** `DeviceManager.initSGC(wearable)` — a
  `if wearable.contains(DeviceTypes.X) { sgc = X() }` chain on both platforms
  (`ios/Source/DeviceManager.swift`, `android/.../DeviceManager.kt`). Adding a
  device = adding a branch here.
- **Device-type constants:** `DeviceTypes` in
  `ios/Source/utils/Constants.swift` and `android/.../utils/Constants.kt`
  (string identifiers + an `ALL` array).
- **Capabilities (gating):** `getModelCapabilities(deviceType)` over a hardcoded
  `HARDWARE_CAPABILITIES` map in
  `mobile/modules/island/src/types/hardware.ts`. An unknown model falls back to
  `NONE`, which silently gates every miniapp behind "Glasses Required" — we hit
  exactly this with `RemoteHarness` and worked around it in
  `mobile/src/utils/hardware/resolveCapabilities.ts`.
- **UI assets:** `mobile/src/utils/getGlassesImage.tsx` — a hardcoded
  `switch (model)` returning a bundled image, **plus** an already-existing
  state+variant resolver `getEvenRealitiesG1Image(style, color, state, side,
  dark, batteryLevel)` for the G1's color/style/case-state renders. This is the
  concrete thing the asset resolver (§6) generalizes.
- **Controllers:** parallel hierarchy under
  `modules/bluetooth-sdk/{ios,android}/.../controllers/ControllerManager.*`.

Note the surface is duplicated across **three layers** that each hardcode the
device set: native drivers (Kotlin + Swift), capabilities (island TS), and UI
assets (app TS). A clean extension point has to cover all three.

## 4. Proposed architecture

### 4.1 One extension point, registered not hardcoded

Replace the `initSGC` switch with a **registry**. Built-in devices register
themselves at startup exactly like third-party ones — no privileged path —
so the mechanism is dogfooded.

```
DeviceRegistry.register({
  id:           "com.acme.glasses.x1",   // reverse-DNS, OEM-owned namespace
  displayName:  "Acme X1",
  kind:         "glasses" | "controller",
  capabilities: DeviceCapabilities,      // §5
  driver:       (host) => GlassesDriver,  // factory; receives a host handle
  assets?:      AssetResolver,            // §6, optional
  match?:       (scanResult) => boolean,  // optional: claim a scanned device
})
```

`DeviceManager` resolves a paired device's `id` to its registered entry and
calls `driver(host)` instead of `switch`-ing on a string.

### 4.2 The driver interface (public, decoupled)

Today's `SGCManager` is ~60 methods that call core singletons directly
(`Bridge.*`, `DeviceStore.*`, `DeviceManager.getInstance().*`). An OEM must
**not** depend on those internals. Two changes make it publishable:

1. **Inject a host handle.** The driver factory receives a `DeviceHost`
   interface — a narrow, stable façade over what drivers currently reach for:
   ```
   interface DeviceHost {
     // outbound device -> app/cloud
     fun emitMicAudio(lc3: ByteArray, frameSize: Int)
     fun emitTouchEvent(gesture: String)
     fun emitImu(accel: FloatArray, gyro: FloatArray?, ...)
     fun emitBattery(level: Int, charging: Boolean)
     fun reportConnectionState(state: ConnectionState)
     fun reportDeviceInfo(info: DeviceInfo)   // fw version, serial, color, ...
     fun savePhoto(bytes: ByteArray, meta: PhotoMeta)
     fun log(msg: String)
   }
   ```
   This replaces the direct `Bridge`/`DeviceStore`/`DeviceManager` calls in
   `RemoteHarness.kt`/`.swift` (good model to refactor from).
2. **Trim to a versioned public subset.** Keep the inbound command surface
   (display/mic/camera/control) but drop or default internal-only members. The
   public protocol is `GlassesDriver` (and `ControllerDriver`); the in-repo
   `SGCManager` becomes an adapter that conforms to the internal expectations
   by delegating to a `GlassesDriver`.

Public inbound surface (illustrative, language-neutral):
```
interface GlassesDriver {
  val capabilities: DeviceCapabilities
  fun connect(id: String)
  fun disconnect()
  // display (only if capabilities.hasDisplay)
  suspend fun showText(text: String)
  suspend fun showBitmap(image: ImageData, rect: Rect?) -> Boolean
  fun clearDisplay()
  fun setBrightness(level: Int, auto: Boolean)
  // audio (only if capabilities.hasMic)
  fun setMicEnabled(on: Boolean)
  // camera (only if capabilities.hasCamera)
  fun requestPhoto(req: PhotoRequest)
  fun startStream(cfg: StreamConfig); fun stopStream()
  // sensors / control
  fun setImuEnabled(on: Boolean)
  fun getBatteryStatus()
  fun ping(); fun cleanup()
}
```

### 4.3 Deployment model: the OEM builds their own branded app

**This is the whole point and it drives everything else.** An OEM does not add a
driver to *our* shipped app. An OEM **builds their own branded mobile app** and
embeds the MentraOS device + cloud + miniapp stack as a **library/SDK**. Inside
their app, at startup, they register their own glasses driver (+ capabilities +
optional branding assets) into the MentraOS `DeviceRegistry`. MentraOS provides
everything below the OEM's UI — pairing, the cloud client, the miniapp runtime,
captions, etc.; the OEM provides their branding and their device driver.

```
  Acme Glasses (the OEM's own app, on the App Store / Play Store)
  ├── Acme's branding + UI
  ├── AcmeX1Driver        (their GlassesDriver, native, in-process)
  └── embeds MentraOS SDK  (device registry, cloud, miniapp runtime, ...)
        └── DeviceRegistry.register(acmeX1Descriptor) at startup
```

Consequences:

- **The driver is in-process native code, linked at build time** into the OEM's
  app — exactly like today's `G2`/`MentraLive` drivers run in our app. It
  typically wraps the OEM's existing native BLE SDK behind the `GlassesDriver`
  interface and calls `DeviceHost` for callbacks.
- **No runtime code-loading problem.** Because it's the OEM's own build, their
  driver is compiled in normally. (The alternative — dropping third-party
  driver code into an already-shipped binary at runtime — is forbidden on iOS
  and was never the plan.)
- **There is no separate process and no socket** on the phone. Mobile OSes
  sandbox apps; the production driver runs inside the OEM's app process and
  uses the phone's Bluetooth directly.

A secondary deployment also works with the identical mechanism: an OEM
contributes a native driver module that ships inside the *MentraOS* app (we
include it in our build). Same `DeviceRegistry.register`, same `GlassesDriver`;
just a different "whose app." But the branded-app model above is the target.

### 4.4 The out-of-process / socket transport is DEV + SIMULATION ONLY

There is a second way to satisfy `GlassesDriver` — a generic
`ExternalDeviceAdapter` that proxies the interface over a local socket to a
separate program (the productized `RemoteHarness`/MDBP path, §7). **This is not
an OEM production path** and cannot be: phones (especially iOS) don't allow a
shipped app to talk to an OEM's separate process over a local socket. It exists
only where separate processes + sockets exist — i.e. **on a computer, for
development and simulation**:

- `RemoteHarness` → the mentra-agent Mac daemon (drive real glasses from a
  laptop during dev — no phone BLE radio needed in the emulator/simulator),
- the **laptop simulator** (the Mac stands in as the glasses),
- optionally an OEM **bench/bring-up tool** that runs their glasses SDK on a
  desktop to exercise MentraOS before the native driver is written.

It shares the same `GlassesDriver` interface (so the app can't tell the
difference), which is what makes it a faithful dev stand-in — but it ships
nowhere near a phone.

### 4.5 Controllers

`ControllerManager` gets the identical treatment: a public `ControllerDriver`
interface, the same `DeviceHost`, capabilities (buttons, touchpad, IMU,
haptics), and the same asset resolver. An OEM can register a glasses driver, a
controller driver, or both. The Even R1 ring is the reference controller.

## 5. Capabilities & gating

The registered `capabilities` feed the existing feature-gate
(`getModelCapabilities` → `HARDWARE_CAPABILITIES`). Today an unknown model →
`NONE` → everything gated (the `RemoteHarness` "Glasses Required" bug). With a
registry, capabilities come from the registration, so:

```
DeviceCapabilities {
  hasDisplay: Bool         displayKind: monochrome | grayscale | color | none
  displayGeometry?: { widthPx, heightPx, ... }   // for layout + the lens mirror
  hasMic: Bool             hasCamera: Bool
  hasImu: Bool             hasSpeaker: Bool
  hasWifi: Bool            buttons: [..]  touchpad: Bool
  ...
}
```

`getModelCapabilities` becomes "ask the registry; fall back to NONE only for
genuinely unknown devices." This also lets the **laptop-simulator** device
(separate proposal) declare a full display+mic+camera superset so every
miniapp lights up.

## 6. Asset / branding resolver

Generalize `getGlassesImage.tsx`. Today it is a hardcoded model→image `switch`
plus `getEvenRealitiesG1Image(style, color, state, side, dark, batteryLevel)`
— which already proves assets must be a **function of runtime state + variant**,
not a single static image (the user's G1-color example).

So the asset pack is a **resolver**, all parts optional:
```
interface AssetResolver {
  icon?: ImageRef
  image(ctx: {
    state: "connected" | "searching" | "disconnected" | "in_case" | "charging" | ...
    variant?: { color?, style?, side? }
    batteryLevel?: Int
    dark?: Bool
  }): ImageRef | null    // null -> app uses generic fallback
}
```

- The app's UI (pairing scan, select-model, success, home `DeviceStatus`,
  settings) calls `registry.assetsFor(id)?.image(ctx)` and falls back to the
  current generic placeholder when null. `getGlassesImage` becomes the
  fallback path, not the source of truth.
- **Shipping the images:** the OEM's branded app bundles them in its assets and
  returns `require`-style refs (the production path). The dev/sim external
  adapter instead passes `ImageRef`s as URIs / file paths / base64 over the
  wire (the app caches/renders them). `ImageRef` abstracts over both.

## 7. The dev/simulation transport (out-of-process, already prototyped)

This is the §4.4 dev-and-simulation transport — **not** an OEM production path.
`RemoteHarness` (dev-only, `agent-harness` branch) is the working seed:

- App side: `RemoteHarness.kt` / `RemoteHarness.swift` — an `SGCManager` that
  opens a TCP socket to a host process and speaks newline-delimited JSON:
  commands out (`{cmd:"text"|"bitmap"|"mic"|"brightness"|"photo"|...}`),
  events in (`{event:"hello"|"status"|"battery"|"gesture"|"imu"|"audio"}`),
  with a liveness ping + reconnect.
- Host side: the mentra-agent daemon (`tools/mentra-agent/ble/`) implements
  that protocol against real BLE glasses.

To generalize `RemoteHarness` into a reusable `ExternalDeviceAdapter` (for the
laptop simulator and dev/bench tools — again, not for shipping OEM apps):
- Freeze + version the wire protocol (MDBP), documented for dev/sim consumers.
- Generalize the hardcoded host/port to a registered endpoint + transport
  (TCP / unix socket / BLE-bridge).
- Carry capabilities + asset refs in the `hello`/`status` handshake (the
  harness already sends the underlying family in `hello` so capabilities
  resolve — generalize that to a full capability + asset payload).
- Replace the direct `Bridge`/`DeviceStore`/`DeviceManager` calls with the
  `DeviceHost` handle (§4.2).

## 8. Versioning & stability

- The public contract (`GlassesDriver`, `ControllerDriver`, `DeviceHost`,
  `DeviceCapabilities`, `AssetResolver`, wire protocol) is **semver'd**
  independently of the app.
- Drivers declare the contract version they target; the registry refuses or
  warns on incompatible majors.
- Internal `SGCManager` can keep churning behind the adapter without breaking
  OEM drivers.

## 9. Trust & safety considerations

- An in-process driver runs with the host app's privileges and can drive
  display/mic/camera — treat third-party drivers as a trust surface: capability
  allow-listing, no implicit access to unrelated app state (the narrow
  `DeviceHost` enforces this), and clear user disclosure of which driver is
  active. In the branded-app model the OEM owns their own app, so the trust
  boundary is mostly between the OEM and the embedded MentraOS SDK.
- The dev/sim external adapter's process is a separate trust/isolation boundary
  but needs auth on the local transport so arbitrary local processes can't
  impersonate glasses.

## 10. Incremental migration path

1. **Extract `DeviceHost`.** Refactor `RemoteHarness` (both platforms) to call
   a `DeviceHost` façade instead of `Bridge`/`DeviceStore`/`DeviceManager`
   directly. Lowest-risk, no behavior change, proves the façade covers a real
   driver.
2. **Introduce `DeviceRegistry`.** Replace `initSGC`'s switch with a registry
   that the built-in drivers register into at startup. Behavior-identical.
3. **Capabilities from registration.** Route `getModelCapabilities` through the
   registry; delete the `RemoteHarness` capability workaround.
4. **Asset resolver.** Make `getGlassesImage` consult the registry's
   `AssetResolver` (G1's existing `getEvenRealitiesG1Image` becomes the first
   resolver implementation), generic fallback preserved.
5. **Publish `GlassesDriver`/`ControllerDriver`** as the OEM-facing subset over
   the internal `SGCManager` (adapter), versioned.
6. **Generalize `ExternalDeviceAdapter`** from `RemoteHarness` for the laptop
   simulator + dev/bench tools: documented, versioned MDBP + registered
   endpoints. (Dev/sim only — not shipped to phones.)
7. **OEM SDK package + docs**: MentraOS published as an embeddable library so an
   OEM can build their own branded app; a native `GlassesDriver` module
   skeleton (Kotlin + Swift), a conformance test suite, and a sample driver +
   sample branded app.

## 11. Open questions

- **How the OEM embeds MentraOS** (RN library vs native AAR/XCFramework, how
  much MentraOS UI is reused vs rebranded) is **owned separately** — out of
  scope for this doc. This spec covers only the device-driver extension point,
  which is independent of the embedding mechanism.
- Driver registration in the OEM's app — an explicit `register()` they call at
  startup (simplest, recommended) vs autolinking discovery?
- Wire-protocol encoding for the dev/sim transport — newline-JSON
  (human-debuggable, what the harness uses) vs protobuf (we already have
  `mentraos_ble.pb`)?
- Do capabilities need to be **dynamic** (change post-connect once real
  hardware info arrives), or static at registration? (G2 vs G1 mic behavior
  suggests at least some dynamic capability refresh.)
- Conformance/certification: what must an OEM driver pass before it's
  "MentraOS compatible"?

## Related

- `docs/bluetooth-sdk-public-api-surface-review.md` — existing public-API surface work
- `tools/mentra-agent/ble/` + `RemoteHarness.{kt,swift}` — the dev/sim transport prototype
- Laptop-simulator device (separate proposal) — a first-party consumer of this
  same extension point, backing display/mic/camera with the host machine.
