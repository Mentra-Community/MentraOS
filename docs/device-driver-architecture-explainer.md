# Device drivers: how it works today, and the OEM adapter by example

Status: **explainer + design sketch** (no implementation yet)
Companion to: `docs/pluggable-device-drivers-oem-sdk.md` (the formal spec)

This doc is for someone who hasn't worked in the device/Bluetooth layer before.
**Part 1** explains how a pair of glasses works in the app *today*. **Part 2**
proposes the naming + structure an OEM would use to add their own device, with
code snippets and a filesystem layout.

---

# Part 1 — How it works today

## 1.1 The one idea: every device is an `SGCManager`

`SGCManager` ("Smart Glasses Connection Manager") is the **interface every
pair of glasses implements**. The app never talks to a G2 or a Mentra Live
directly — it holds one `sgc` object that conforms to `SGCManager`, and calls
methods like `sendTextWall(...)` or `setMicEnabled(...)` on it. Each real
device is a class implementing that interface:

```
SGCManager (interface)
├── G1            (Even Realities G1, BLE)
├── G2            (Even Realities G2, BLE)
├── MentraLive    (camera glasses, BLE)
├── MentraNex     (display glasses, BLE)
├── Mach1 / Z100  (Vuzix)
├── Simulated     (fake device, no hardware)
└── RemoteHarness (dev-only: proxies over TCP to a laptop daemon holding real glasses)
```

- iOS: `mobile/modules/bluetooth-sdk/ios/Source/sgcs/SGCManager.swift` (a
  `@MainActor protocol`)
- Android: `mobile/modules/bluetooth-sdk/android/.../sgcs/SGCManager.kt`

The interface has ~60 methods grouped as: **display** (`sendTextWall`,
`displayBitmap`, `clearDisplay`, `setBrightness`), **audio** (`setMicEnabled`),
**camera** (`requestPhoto`, `startStream`), **sensors/control** (`setImuEnabled`,
`getBatteryStatus`), and **connection** (`connect`, `disconnect`,
`findCompatibleDevices`, `cleanup`).

A device is identified by a **type string** in `DeviceTypes`
(`utils/Constants.swift` / `.kt`). The real values:

```
"Even Realities G1" | "Even Realities G2" | "Mentra Live" | "Mentra Display"
| "Mentra Mach1" | "Vuzix Z100" | "Brilliant Frame" | "Simulated Glasses"
| "Remote Glasses (Harness)"
```

## 1.2 The layers (and the React Native boundary)

The app is React Native: **TypeScript UI** on top, **native Kotlin/Swift** for
Bluetooth (the OS only exposes BLE to native code). They talk through an **Expo
native module** named `BluetoothSdk`.

```
  ┌─────────────────────────────────────────────┐
  │  TypeScript / React (the app you see)         │
  │   src/app/pairing/*, src/services/*, stores   │
  └───────────────┬───────────────▲───────────────┘
        calls     │               │  events
  (connect, etc.) │               │ (battery, mic, ...)
  ┌───────────────▼───────────────┴───────────────┐
  │  Expo module "BluetoothSdk"                    │
  │   AsyncFunction(...) in    Bridge.sendEvent(...) │
  │   BluetoothSdkModule.{kt,swift}                │
  └───────────────┬───────────────▲───────────────┘
                  │               │
  ┌───────────────▼───────────────┴───────────────┐
  │  DeviceManager  (holds the active `sgc`)        │
  │   initSGC(type) picks the driver class          │
  └───────────────┬───────────────▲───────────────┘
        commands   │               │  callbacks
  (sendTextWall)   │               │ (Bridge.*, DeviceStore.apply)
  ┌───────────────▼───────────────┴───────────────┐
  │  SGCManager driver  (G2 / Live / RemoteHarness) │
  │   ── BLE ──>  physical glasses                  │
  └────────────────────────────────────────────────┘
```

Two helper singletons the drivers lean on:
- **`Bridge`** — sends events *up* to JS. Core call: `sendTypedMessage(type,
  body)` → the Expo module emits an event JS listens for. Helpers:
  `sendMicLc3`, `sendBatteryStatus`, `sendTouchEvent`, `sendAccelEvent`,
  `sendDiscoveredDevice`, `log`.
- **`DeviceStore`** — a key/value state store (`apply(category, key, value)`).
  Drivers write things like `("glasses","connected",true)` /
  `("glasses","batteryLevel",87)`; changes both propagate to JS and trigger
  side-effects (e.g. setting `brightness` calls `sgc.setBrightness`).

## 1.3 Lifecycle: from "tap your glasses" to a live connection

1. **Pick a model** — `src/app/pairing/select-glasses-model.tsx` shows a
   **hardcoded list** of models and routes into the pairing guide.
2. **Scan** — `src/app/pairing/scan.tsx` calls `BluetoothSdk.startScan(model)`.
   The native driver scans BLE; for each device found it calls
   `Bridge.sendDiscoveredDevice(model, name, …)`, which lands in
   `DeviceStore` `bluetooth.searchResults`, which the scan screen reads from a
   store — so results appear in the UI.
3. **Connect** — tapping a result calls `BluetoothSdk.connect(device)`. That
   crosses into the Expo module (`AsyncFunction("connectWithOptions")`), into
   `MentraBluetoothSDK`, which calls **`DeviceManager.initSGC(type)`**.
4. **`initSGC` is the factory** — a big `if/else` on the type string that
   `new`s the right driver class:
   ```swift
   if wearable.contains(DeviceTypes.REMOTE_HARNESS) { sgc = RemoteHarness() }
   else if wearable.contains(DeviceTypes.G2)        { sgc = G2() }
   else if wearable.contains(DeviceTypes.LIVE)      { sgc = MentraLive() }
   // ...
   ```
   (`DeviceManager.swift` ~`initSGC`, mirrored in `DeviceManager.kt`.)
5. **Driver connects** and reports readiness via `DeviceStore.apply("glasses",
   "connected", true)` + `Bridge` events. The app's stores update and the home
   screen shows the connected glasses.

## 1.4 The two everyday data flows

**Inbound — app wants to show text on the lens:**
```
miniapp / cloud  →  DeviceManager.sgc  →  sgc.sendTextWall("Hi")  →  BLE  →  glasses
```
Whoever has the `sgc` reference (held in `DeviceManager`) calls the interface
method; the concrete driver turns it into the device's wire format.

**Outbound — glasses mic → captions:**
```
glasses mic → driver → DeviceManager.handleGlassesMicData(lc3, 40)
            → Bridge.sendMicLc3(...) → Expo event "mic_lc3"
            → JS listener (MantleManager) → cloud client → transcription
```
(`RemoteHarness` is a great concrete example: its socket receives
`{event:"audio", b64:...}`, base64-decodes the LC3, and calls
`DeviceManager.handleGlassesMicData` — exactly the same entry point a real BLE
driver uses.)

## 1.5 The catch: a device is hardcoded in THREE places

To add a device today you must edit core, in three separate layers:

| # | Layer | File | What's hardcoded |
|---|-------|------|------------------|
| A | **Driver factory** | `DeviceManager.{swift,kt}` `initSGC` | the `if/else` that picks the driver class |
| B | **Capabilities** (gating) | `modules/island/src/types/hardware.ts` `HARDWARE_CAPABILITIES` / `getModelCapabilities` | what the device can do → which miniapps are enabled. Unknown model → `NONE` → everything gated behind "Glasses Required" |
| C | **UI assets** | `mobile/src/utils/getGlassesImage.tsx` | `switch(model)` → bundled image. Note `getEvenRealitiesG1Image(style,color,state,side,dark,battery)` is already a *state+variant resolver* — but only for G1 |

Plus the model has to be added to the pairing list and `DeviceTypes`. **An OEM
can't do any of this without forking the repo.** That's the problem the adapter
solves.

`RemoteHarness` is the proof it *can* be done differently: it's a driver that
isn't real hardware at all — it proxies over a TCP/JSON socket to an external
process. An OEM device is the same shape, just owned by the OEM.

---

# Part 2 — The OEM adapter, by example

## 2.1 Naming

| Concept | Proposed name | What it is |
|---|---|---|
| The OEM-facing SDK package | **`@mentra/device-sdk`** (TS types + JS registration) and native libs **`MentraDeviceSDK`** (Swift package / Android library) | what an OEM depends on |
| The thing they implement | **`GlassesDriver`** / **`ControllerDriver`** (both refine **`DeviceDriver`**) | the public, trimmed, versioned subset of today's `SGCManager` |
| The handle we give them | **`DeviceHost`** | narrow façade replacing direct `Bridge`/`DeviceStore`/`DeviceManager` access |
| What they declare | **`DeviceDescriptor`** = `{ id, displayName, kind, capabilities, driver, assets?, match? }` | registered into the app |
| Capabilities | **`DeviceCapabilities`** | drives feature-gating |
| Branding images | **`DeviceAssets`** with `imageFor(context)` | optional, state+variant resolver |
| The registry | **`DeviceRegistry`** (`registerDevice(descriptor)`) | replaces the `initSGC` switch |
| Tier A | **native plugin** | implement `GlassesDriver` in Kotlin+Swift, ship a module |
| Tier B | **`ExternalDeviceAdapter`** speaking **MDBP** (Mentra Device Bridge Protocol) | OEM runs a process in any language; productized `RemoteHarness` |

`id` is reverse-DNS and OEM-owned: `com.acme.glasses.x1`. It namespaces the
device so two OEMs never collide (unlike today's free-form strings).

## 2.2 The descriptor — one registration call

Everything about a device is one object. Built-in devices register the same way
(dogfooding):

```ts
// what an OEM (or we) call at startup
import { registerDevice, ConnectionState } from "@mentra/device-sdk"

registerDevice({
  id: "com.acme.glasses.x1",
  displayName: "Acme X1",
  kind: "glasses",                          // or "controller"

  capabilities: {
    hasDisplay: true, displayKind: "grayscale",
    displayGeometry: { widthPx: 640, heightPx: 200 },
    hasMic: true, hasCamera: false, hasImu: true, hasSpeaker: false,
  },

  // optional: how it looks in the app (Part 2.5)
  assets: {
    icon: img("x1/icon.png"),
    imageFor: ({ state, variant }) =>
      state === "searching" ? img("x1/searching.png")
      : variant?.color === "black" ? img("x1/black.png")
      : img("x1/default.png"),
  },

  // the actual driver — a factory we call, handing it the host
  driver: (host) => new AcmeX1Driver(host),
})
```

If `capabilities`/`assets` are omitted, the device still works but with default
gating and a generic image — they're progressive enhancement.

## 2.3 Tier A — in-process native driver (Kotlin/Swift)

The OEM implements `GlassesDriver`. The key difference from today's
`SGCManager`: it receives a **`DeviceHost`** and calls *that* instead of the
global `Bridge`/`DeviceStore`. Illustrative Kotlin:

```kotlin
class AcmeX1Driver(private val host: DeviceHost) : GlassesDriver {

  override val capabilities = DeviceCapabilities(hasDisplay = true, hasMic = true /* ... */)

  override fun connect(id: String) {
    host.reportConnectionState(ConnectionState.CONNECTING)
    acmeSdk.connect(id) { evt ->
      when (evt) {
        is Connected -> host.reportConnectionState(ConnectionState.CONNECTED)
        is Battery   -> host.emitBattery(evt.level, evt.charging)
        is MicFrame  -> host.emitMicAudio(evt.lc3, frameSize = 40)   // -> captions
        is Tap       -> host.emitTouchEvent("single_tap")
      }
    }
  }

  // inbound commands (only the ones our capabilities advertise)
  override suspend fun showText(text: String) = acmeSdk.draw(text)
  override suspend fun showBitmap(img: ImageData, rect: Rect?) = acmeSdk.draw(img)
  override fun setMicEnabled(on: Boolean) = acmeSdk.mic(on)
  override fun setBrightness(level: Int, auto: Boolean) = acmeSdk.brightness(level)

  override fun disconnect() = acmeSdk.disconnect()
  override fun cleanup() = acmeSdk.close()
}
```

`DeviceHost` is the entire surface they're allowed to touch — nothing about the
rest of the app leaks in:

```kotlin
interface DeviceHost {
  fun reportConnectionState(state: ConnectionState)
  fun reportDeviceInfo(info: DeviceInfo)          // fw, serial, color/variant
  fun emitBattery(level: Int, charging: Boolean)
  fun emitMicAudio(lc3: ByteArray, frameSize: Int)
  fun emitTouchEvent(gesture: String)
  fun emitImu(accel: FloatArray, gyro: FloatArray?)
  fun savePhoto(bytes: ByteArray, meta: PhotoMeta)
  fun log(msg: String)
}
```

Internally the app wraps the OEM's `GlassesDriver` in an **adapter** that
satisfies the existing internal `SGCManager`, so the rest of `DeviceManager`
doesn't change. The OEM never sees `SGCManager`.

## 2.4 Tier B — out-of-process (any language), the recommended default

The OEM doesn't write Kotlin/Swift at all. They run **their own process** that
speaks **MDBP** (the productized `RemoteHarness` protocol — newline-delimited
JSON over a local socket). The app side is a single built-in
`ExternalDeviceAdapter` that implements `GlassesDriver` by relaying to that
process. The OEM registers a descriptor whose `driver` is the external adapter
pointed at their endpoint:

```ts
registerDevice({
  id: "com.acme.glasses.x1",
  displayName: "Acme X1",
  kind: "glasses",
  capabilities: { /* sent in the MDBP handshake instead, see below */ },
  driver: externalDriver({ transport: "tcp", host: "127.0.0.1", port: 9400 }),
})
```

The wire protocol (what RemoteHarness already does, generalized):

```jsonc
// app -> OEM process (commands)
{ "cmd": "text",   "text": "Hello" }
{ "cmd": "bitmap", "b64": "...", "x": 0, "y": 0, "width": 640, "height": 200 }
{ "cmd": "mic",    "enable": true }
{ "cmd": "photo",  "opts": { "requestId": "...", "transferMethod": "wifi" } }

// OEM process -> app (events + handshake)
{ "event": "hello", "connected": true,
  "capabilities": { "hasDisplay": true, "hasMic": true, "displayGeometry": {...} },
  "assets": { "connected": "file:///.../x1.png", "searching": "..." } }
{ "event": "battery", "level": 88, "charging": false }
{ "event": "audio",   "b64": "<lc3>" }          // -> captions
{ "event": "gesture", "gesture": "swipe_up" }
{ "event": "ping" }                              // liveness
```

Note the `hello` carries **capabilities and assets** — so a Tier-B OEM doesn't
touch any TS at all; the device fully describes itself over the socket. (This
is the one real generalization needed beyond today's RemoteHarness, which sends
only a family name.)

This is exactly how the **laptop simulator** will work: it's a Tier-B backend
whose "hardware" is the Mac (a display window + the laptop mic/camera), proving
the path before any OEM uses it.

## 2.5 Assets — state + variant resolver

Generalizes `getGlassesImage` + `getEvenRealitiesG1Image`. The app asks the
registry; falls back to the generic image when the resolver returns null:

```ts
// app UI (pairing, home card, settings) — conceptual
const img = registry.assetsFor(deviceId)?.imageFor({
  state: connectionState,          // connected | searching | disconnected | in_case | charging
  variant: { color, style, side }, // e.g. G1's grey/brown/green, round/rectangular
  batteryLevel, dark,
}) ?? getGlassesImage(deviceId)     // existing generic fallback
```

The G1's existing `getEvenRealitiesG1Image(style, color, state, side, dark,
battery)` becomes the *first implementation* of an `imageFor` resolver, instead
of a special case wired into the app.

## 2.6 What an OEM's repo looks like

**Tier A (native plugin)** — a standalone Expo module the OEM publishes:

```
acme-mentra-glasses/                 # OEM's own repo, depends on @mentra/device-sdk
├── package.json                     # peerDep: @mentra/device-sdk
├── src/
│   └── index.ts                     # registerDevice({... driver: native ...})
├── ios/
│   ├── AcmeX1Driver.swift           # implements GlassesDriver
│   └── AcmeMentraGlasses.podspec
├── android/
│   └── src/main/java/.../AcmeX1Driver.kt
└── assets/glasses/x1/               # connected.png, searching.png, black.png, icon.png
```
The app gains the device by adding this package as a dependency.

**Tier B (external process)** — no native code, any language:

```
acme-glasses-bridge/                 # OEM's own repo, any language
├── bridge.py        (or .go/.rs/.ts)# speaks MDBP on a local socket
├── README.md                        # "run this alongside MentraOS"
└── assets/                          # images referenced by file:// in the hello
```
The OEM ships a tiny config (or a one-line `registerDevice` in a thin plugin)
telling the app the endpoint; everything else flows over MDBP.

## 2.7 How a command flows, end to end (Acme X1, Tier B)

```
miniapp: session.layouts.showText("Hi")
  → cloud → app → DeviceManager.sgc (= ExternalDeviceAdapter for com.acme.glasses.x1)
  → adapter.showText("Hi")
  → MDBP: { "cmd":"text", "text":"Hi" }  over the socket
  → Acme's process → Acme's BLE/proprietary link → the X1 lens
```
And mic back:
```
X1 mic → Acme's process → MDBP { "event":"audio","b64":... }
  → ExternalDeviceAdapter → host.emitMicAudio(lc3,40)
  → DeviceManager.handleGlassesMicData → Bridge.sendMicLc3 → JS → cloud → captions
```
The app code in the middle is identical to what runs for a real G2 — the OEM
just owns the bottom two rows.

---

# Where this is going (sequencing)

The formal migration path is in `docs/pluggable-device-drivers-oem-sdk.md` §10.
The lowest-risk first step is extracting `DeviceHost` by refactoring
`RemoteHarness` to use it (no behavior change), then introducing
`DeviceRegistry` so built-ins register through it, then routing capabilities and
assets through the registry. The laptop simulator is the first end-to-end
consumer of Tier B and shakes out the MDBP handshake (capabilities + assets)
before any external OEM depends on it.
