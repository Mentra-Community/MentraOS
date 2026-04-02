# Issues with session.camera.setFov()

## Overview

**What this doc covers:** Design concerns with the `session.camera.setFov()` API that landed in dev without review — specifically the lack of camera settings ownership model, interaction with existing camera bugs, and multi-app state conflicts.
**Why this doc exists:** This API was added to the public SDK surface without a design review. It exposes a deeper problem: every camera-adjacent API has been added in isolation, each making implicit assumptions about ownership and state that conflict with each other. This doc is meant to start that conversation before more APIs land.
**Who should read this:** Everyone who touches the SDK public API surface, cloud session management, or mobile camera integration.

## Background

The glasses camera is a shared hardware resource. Its state — FOV, resolution, ROI crop position — lives on the physical device, configured over BLE from the mobile app. It is not scoped to an app session. When any code path changes a camera setting, that change is global and persists until something explicitly changes it back.

We currently have three ways to interact with the camera from the SDK:

- `session.camera.takePhoto()` — photo request
- `session.camera.startStream()` / `stopStream()` — RTMP streaming
- `session.camera.setFov()` — new, sets FOV + ROI (added without review)

Each was designed independently. None of them define who owns camera state or what happens when multiple apps hold CAMERA permission simultaneously.

## The Problem in 30 Seconds

`setFov()` changes a hardware-level global setting on the glasses. There is no rollback when the app disconnects, no notification to other apps that the setting changed, and no concept of "this app's FOV" vs "the current FOV." The API looks like it's scoped to your app. It isn't.

## Mobile & ASG Audit: What Actually Happens

Traced the full call chain through mobile (`SocketComms.ts`, `settings.ts`, `GlassesStore`) and ASG (`SettingsCommandHandler.java`, `AsgSettings.java`). The results are worse than the cloud-side design suggested.

### Full call chain

```
App: session.camera.setFov({ fov: 82, roiPosition: "top" })
  → WebSocket → cloud handler → userSession.websocket
  → mobile SocketComms.handle_camera_fov_set(msg)
  → useSettingsStore.setSetting("camera_fov", {fov:82, roi_position:2}, false)
      persist:true → saves to phone local storage (permanent)
      updateServer=false → skips server sync
  → CORE_SETTINGS_KEYS subscription fires → CoreModule.updateCore()
  → GlassesStore.apply("core", "camera_fov")
  → sgc.sendCameraFovSetting() → BLE
  → ASG SettingsCommandHandler.handleCameraFovSetting()
      → asgSettings.setCameraFov(82, 2)  // SharedPreferences — survives reboot
      → DevApi.setCameraFov(82, 2)       // kernel-level hardware write
      → SysControl.restartCameraHal()    // CAMERA HAL RESTART
```

### It is global. It is permanent.

`camera_fov` is `persist: true` in the settings store. When an app calls `setFov()`, the value is written to phone local storage unconditionally — the `false` flag only skips the server sync, not the local persist. The value also gets committed to SharedPreferences on the glasses and **survives reboots**.

On every glasses reconnect, `MantleManager.init()` calls `CoreModule.updateCore(getCoreSettings())` which includes `camera_fov`. So the app-set value is re-applied to the glasses every time the BLE connection re-establishes, even if the app that set it has long since disconnected.

### The user's Camera Settings screen reads the same key

`mobile/src/app/miniapps/settings/camera.tsx`:

```typescript
const [cameraFovSetting, setCameraFovSetting] = useSetting(SETTINGS.camera_fov.key)
```

`SocketComms.handle_camera_fov_set`:

```typescript
useSettingsStore.getState().setSetting(SETTINGS.camera_fov.key, {fov, roi_position: numericRoi}, false)
```

Same key. After App A calls `setFov({ fov: 82 })`, the user opens Camera Settings and sees FOV at 82 — a value they never set. There is no indicator that an app changed it. There is no way for the user to know why.

### The camera HAL restarts on every call

`SysControl.restartCameraHal()` is called synchronously in `handleCameraFovSetting`. Every `setFov()` call from an SDK app restarts the camera HAL on the glasses. If a photo is in-flight, a stream is active, or anything else is using the camera, it gets disrupted. There is a `CameraRestartCooldown` guard but it is not surfaced to the SDK caller.

### Only Mentra Live (K900) implements it — everyone else is a no-op

| Device             | `sendCameraFovSetting()`                                            |
| ------------------ | ------------------------------------------------------------------- |
| Mentra Live (K900) | ✅ Full implementation — reads GlassesStore, sends BLE, HAL restart |
| Mentra Nex         | No-op — logs "operation not supported"                              |
| Even Realities G1  | Empty method body                                                   |
| Even Realities G2  | Logs only — no BLE send                                             |
| Mach1              | Empty method body                                                   |
| Simulated          | Logs only                                                           |

The SDK method returns `void` with no indication of whether the hardware actually supports FOV control. An app targeting G1 users will call `setFov()` and nothing will happen — silently.

---

## Concerns

### 1. FOV is global hardware state, not per-app state — confirmed

`setFov()` pushes a BLE command that changes the physical sensor configuration on the glasses. Once set, it stays set — persisted to phone local storage AND glasses SharedPreferences, re-applied on every BLE reconnect. The path is:

```
App calls setFov({ fov: 82 }) → Cloud → Mobile → local storage (permanent)
                                                → BLE → Glasses SharedPreferences (permanent)
                                                        (survives reboots, reconnects)
```

If App A sets `fov: 82` and then App B calls `takePhoto()`, App B gets an 82° photo. App B has no idea the FOV was changed. There is no:

- Restore-on-disconnect (when App A exits, FOV stays at 82 in both phone and glasses storage)
- Query-current-state (App B can't ask "what is the current FOV?")
- Change notification (App B doesn't know App A touched the setting)
- Default-on-session-start (each new app session inherits whatever state was last persisted)

The permission model (`checkCameraPermission`) only gates whether an app _can_ access the camera — it says nothing about what happens when multiple apps hold that permission concurrently.

### 2. This is the same root problem as the existing photo resolution bug

There is an existing bug: when a developer triggers a photo using the same hardware button as the default system photo, the photo comes back with the _user's_ camera settings instead of the developer's requested settings. Devs cannot reliably control resolution, compression, or other parameters through the SDK when the system's own camera path is also active.

That bug exists because there are two separate code paths mutating the same shared camera state — the SDK path and the system path — with no reconciliation between them. `setFov()` adds a third code path that mutates the same shared state.

The bug is not an edge case. It is evidence of the missing ownership model. Every new camera API added without that model makes the surface area for these bugs larger.

### 3. Multi-app camera settings: no design exists

Consider two apps that both have CAMERA permission and are both running:

- App A is a photography app. It sets `fov: 82` for a narrow crop.
- App B is a navigation overlay. It calls `takePhoto()` expecting full-sensor coverage.
- App B gets a narrow 82° photo. No error. No warning. Wrong output.

Questions that have no answer today:

- Who "owns" camera settings at any given time?
- Does the last writer win? First writer? Whoever holds camera ownership?
- Should there be a camera settings lock, similar to the display ownership model?
- When an app with CAMERA permission disconnects, should the system restore a default state?
- If yes, what is the default — user preference? Hardware default? Last system-set value?
- Should apps be able to _read_ current camera settings before changing them?

### 4. The public API implies ownership it doesn't have

```typescript
await session.camera.setFov({fov: 92, roiPosition: "top"})
```

The method is on `session.camera` — namespaced to _this_ session, _this_ app. That implies the setting is scoped to this app's camera usage. It isn't. A developer reading this API will reasonably assume:

- "My app sets FOV to 92 for my photos"
- "When my app stops, FOV goes back to normal"
- "Other apps aren't affected"

All three of those assumptions are false. There is nothing in the JSDoc, the method signature, or the SDK documentation that communicates this. We are shipping an API that will cause confusing, hard-to-reproduce bugs for third-party developers — the same category of problem as the resolution bug above, except now we've handed the footgun to external developers.

### 5. The requestId goes nowhere

`CameraFovSetRequest` includes a `requestId` field. It gets threaded through the cloud handler and into `CameraFovSetToGlasses`. But there is no response message type — no `CAMERA_FOV_SET_RESPONSE`, no `CloudToAppMessageType` variant, nothing. The SDK promise resolves the moment the message is sent from the app.

The following failure modes are completely silent to the app:

- Mobile is connected to cloud, but BLE to glasses is down
- Glasses rejects the value (hardware doesn't support that FOV on this revision)
- Mobile app hasn't implemented the `CAMERA_FOV_SET` handler
- Glasses is in the middle of a reconnect cycle

A `requestId` that routes to nothing is a design smell — it looks like a response was planned and then dropped. Fire-and-forget is a valid choice, but it should be a deliberate one with documented failure modes, not an accidental one.

### 6. FOV valid values are inconsistent across SDK and cloud

The SDK allows any integer 82–118 (continuous range check):

```typescript
// sdk/src/app/session/modules/camera.ts
if (fov < 82 || fov > 118) throw new Error(...)
```

The cloud only accepts four discrete values:

```typescript
// app-message-handler.ts
const SUPPORTED_FOV = [82, 92, 102, 118]
```

An app passing `fov: 85` passes SDK validation with no error, gets sent to the cloud, and receives a `MALFORMED_MESSAGE` error back — with no indication from the SDK that 85 was never going to work. The SDK docs say `82-118`. The cloud says pick one of four. A developer will try values in that range and get mysterious errors.

This needs a single source of truth from the hardware team: is it discrete or continuous?

### 7. Every setFov() call restarts the camera HAL

The ASG `handleCameraFovSetting` unconditionally calls `SysControl.restartCameraHal()`. This means:

- If an app calls `setFov()` while another app is streaming, the stream breaks
- If a photo request is in-flight, it gets disrupted
- Calling `setFov()` in a loop (e.g. animating FOV) would repeatedly restart the HAL
- The `CameraRestartCooldown` guard exists on the ASG side but is invisible to SDK callers — no error, no feedback

### 8. The API silently does nothing on most devices

Only Mentra Live (K900) has a real implementation. G1, G2, Mach1, and Nex all have empty or log-only stubs. A developer building an app for G1 users will call `setFov()`, get no error, and wonder why their photos look the same. There is no capability check in the SDK before sending the message, and no error response from the cloud or mobile if the device doesn't support it.

---

## The Bigger Picture

This isn't just about `setFov()`. It's about a pattern.

Camera is one of the most complex, stateful, shared resources on the device. Each time a new camera API lands without a holistic design — photo request, streaming, now FOV — it adds more surface for bugs like the resolution one. The issues compound because they share the same underlying hardware state with no ownership model.

The audit of the mobile and ASG code makes this concrete: `setFov()` is not a "hint to the camera" — it's a permanent write to user settings storage that survives app disconnects, phone restarts, and glasses reboots. The user's own Camera Settings screen reflects the app-set value with no attribution. This is the resolution bug pattern, but now fully confirmed in the storage layer.

Before any more camera APIs are added to the public SDK, we need answers to:

1. **Who owns camera state?** App? System? User preferences? The last caller?
2. **What is the contract on app disconnect?** Does camera state reset? To what?
3. **How does multi-app access work?** Do settings from App A persist into App B's camera calls?
4. **Should there be a camera settings API?** A first-class `CameraSettings` object that apps request, hold, and release — rather than individual scattered setters?
5. **What is the interaction with the existing resolution/button bug?** Does fixing the ownership model fix that too, or are they separate?

## What This Is Not Asking For

This is not asking to revert `setFov()` or block the feature. The underlying hardware capability is useful.

This is asking for a design doc on camera settings ownership before more public API surface gets added. The cost of getting this wrong is third-party developers hitting confusing bugs they can't diagnose — which is exactly what the existing resolution bug does today, and exactly what an undocumented global FOV mutation will do tomorrow.

## Next Steps

1. Discuss as a team: does a camera settings ownership model need to exist before more camera APIs ship?
2. If yes: write a spike on what that model looks like (camera lock? settings snapshot/restore? per-app config that gets applied on photo/stream request rather than immediately pushed to hardware?)
3. Decide on the FOV valid value question (discrete vs continuous) from hardware spec.
4. Fix the immediate build bugs (tracked in `spike.md` in this folder).
