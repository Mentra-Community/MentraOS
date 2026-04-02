# Spike: Camera FOV/ROI Control — Audit of Unreviewed Feature

## Overview

**What this doc covers:** End-to-end audit of the camera FOV/ROI control feature added to dev without review — message types, SDK surface, cloud handler, hardware capability registration, and all bugs found.
**Why this doc exists:** The feature was merged into dev without a review. Before it reaches staging or any app developer uses the SDK method, we need to understand what was built, verify correctness, and document what needs to be fixed.
**Who should read this:** Cloud backend engineers, SDK maintainers, anyone debugging a `CAMERA_FOV_SET` flow or working on glasses hardware integration.

## Background

The glasses camera has a configurable field-of-view (FOV) — how wide or narrow the image sensor captures. It can also apply a region-of-interest (ROI) crop to shift the visible frame up or down within the sensor. Prior to this feature, apps had no way to control FOV or ROI at runtime.

The standard cloud message path for hardware control is:

```
App SDK (WebSocket) → Cloud handler → userSession.websocket → Mobile app (BLE) → Glasses
```

The cloud is a passthrough relay — it validates the message and forwards it. The mobile app owns the BLE layer and pushes the setting to the glasses.

## What Was Added

### Files changed across packages

| File                                                         | What changed                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `sdk/src/types/message-types.ts`                             | Added `CAMERA_FOV_SET` to both `AppToCloudMessageType` and `CloudToGlassesMessageType`                        |
| `sdk/src/types/messages/app-to-cloud.ts`                     | Added `CameraRoiPosition` string union, `CameraFovSetRequest` interface, `isCameraFovSetRequest` type guard   |
| `sdk/src/types/messages/cloud-to-glasses.ts`                 | Added `CameraFovSetToGlasses` interface; added to `CloudToGlassesMessage` union                               |
| `sdk/src/app/session/modules/camera.ts`                      | Added `CameraFovOptions` interface, `VALID_ROI_POSITIONS` constant, `setFov()` async method on `CameraModule` |
| `sdk/src/index.ts` + `sdk/src/types/index.ts`                | Exported new types, interfaces, and type guard                                                                |
| `cloud/src/services/session/handlers/app-message-handler.ts` | Added routing case for `CAMERA_FOV_SET`, new `handleCameraFovSet()` function                                  |
| `cloud/src/config/capabilities/mentra-display.ts`            | New capability profile for Mentra Display hardware                                                            |
| `cloud/src/config/hardware-capabilities.ts`                  | Registered Mentra Display in `HARDWARE_CAPABILITIES` map                                                      |
| `types/src/capabilities/mentra-display.ts`                   | Same capability profile, duplicated in `@mentra/types`                                                        |
| `types/src/hardware.ts`                                      | Registered Mentra Display; exported `mentraDisplay`                                                           |
| `types/src/enums.ts`                                         | Added `ControllerTypes` enum with `R1 = "Even Realities R1"`                                                  |
| `types/src/index.ts`                                         | Exported `ControllerTypes`                                                                                    |
| `react-sdk/src/useMentraBridge.ts`                           | Added `CapsuleMenuRect` type, `getCapsuleMenuRect`, `useCapsuleMenu`                                          |
| `react-sdk/src/index.ts`                                     | Exported `CapsuleMenuRect`, `getCapsuleMenuRect`, `useCapsuleMenu`                                            |
| `cloud/src/services/incidents/incident-processor.service.ts` | Commented out Linear ticket creation and email notifications                                                  |

### Data flow

```
App: session.camera.setFov({ fov: 92, roiPosition: "top" })
  ↓ builds CameraFovSetRequest, calls session.sendMessage()
  ↓ WebSocket → cloud
Cloud: handleCameraFovSet()
  ↓ checkCameraPermission()
  ↓ validate fov + roiPosition
  ↓ builds CameraFovSetToGlasses, sends to userSession.websocket
  ↓ WebSocket → mobile app
Mobile: receives CAMERA_FOV_SET message
  ↓ BLE
Glasses: applies FOV/ROI setting
  [no response path back to app]
```

### SDK surface

```typescript
// packages/sdk/src/app/session/modules/camera.ts

export type CameraRoiPosition = "center" | "top" | "bottom"

export interface CameraFovOptions {
  fov: number // 82-118. 118 = full sensor, no crop
  roiPosition?: CameraRoiPosition // defaults to "center"
}

// Usage:
await session.camera.setFov({fov: 92, roiPosition: "top"})
```

The promise resolves when the message is sent from the SDK — not when the glasses apply it.

## Findings

### 1. Build-breaking type mismatch in cloud handler (TS2365)

**File:** `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts:331`

```typescript
// As written — does not compile:
if (!SUPPORTED_FOV.includes(fov) || roiPosition < 0 || roiPosition > 2) {
```

`roiPosition` is typed as `CameraRoiPosition = "center" | "top" | "bottom"` (a string union). The numeric comparisons `< 0` and `> 2` produce `TS2365: Operator '<' cannot be applied to types 'string' and 'number'`. This breaks the entire `@mentra/cloud` build.

The validation predates the string union — `roiPosition` was originally a `0 | 1 | 2` number type that was changed to strings, and the cloud handler was not updated.

The fix: replace the numeric range check with a set membership check, and update the error message accordingly.

```typescript
// Fixed:
const VALID_ROI_POSITIONS: CameraRoiPosition[] = ["center", "top", "bottom"];
const { fov, roiPosition } = message;
if (!SUPPORTED_FOV.includes(fov) || !VALID_ROI_POSITIONS.includes(roiPosition)) {
  sendError(..., `Invalid FOV/ROI: fov must be one of [${SUPPORTED_FOV.join(", ")}], roiPosition must be one of ${VALID_ROI_POSITIONS.map(p => `"${p}"`).join(", ")}`, logger);
}
```

Also requires importing `CameraRoiPosition` from `@mentra/sdk` in the handler.

### 2. FOV validation discrepancy between SDK and cloud

The SDK `setFov()` allows any continuous integer 82–118:

```typescript
// sdk/src/app/session/modules/camera.ts:314
if (fov < 82 || fov > 118) {
  throw new Error(`fov must be between 82 and 118, got ${fov}`)
}
```

The cloud handler allows only 4 discrete values:

```typescript
// app-message-handler.ts:329
const SUPPORTED_FOV = [82, 92, 102, 118];
if (!SUPPORTED_FOV.includes(fov)) { ... }
```

An app passing `fov = 85` passes SDK validation (no throw), reaches the cloud, and gets rejected with `MALFORMED_MESSAGE`. The app developer sees an error with no explanation from the SDK side — the SDK docs say 82–118, but only 4 values actually work. Either:

- The SDK validation needs to be updated to the same discrete list, **or**
- The cloud should be updated to accept the continuous range (if hardware supports it)

This needs a decision from whoever owns the glasses hardware spec.

### 3. Stale error message

Even after fixing bug 1, the original error message still refers to the old numeric format:

```typescript
;`Invalid FOV/ROI: fov must be one of [${SUPPORTED_FOV.join(", ")}], roiPosition must be 0-2`
//                                                                      ^^^^^^^^^^^^^^^^^^^^
```

`roiPosition must be 0-2` is wrong — should describe the string values.

### 4. No hardware capability check before forwarding

`handleCameraFovSet` checks CAMERA permission but never checks whether the session's device actually has a camera. Mentra Display (`hasCamera: false`) can have apps with CAMERA permission. On a Mentra Display session, a `CAMERA_FOV_SET` message would pass the permission check and be forwarded to mobile — which either silently drops it or pushes it over BLE to a glasses model that has no camera.

`checkCameraPermission()` checks the app's permissions, not the device's hardware. There is no capability gate here. Compare to `handlePhotoRequest`, which also lacks this check (existing pattern), but FOV control is more hardware-specific.

### 5. Fire-and-forget with no acknowledgment path

The `requestId` field exists on `CameraFovSetRequest` and is threaded through to `CameraFovSetToGlasses`, but there is no corresponding response message type anywhere:

- No `GlassesToCloudMessageType.CAMERA_FOV_SET_RESPONSE`
- No `CloudToAppMessageType.CAMERA_FOV_SET_RESPONSE`
- The SDK resolves the promise the instant `sendMessage()` is called

Failure modes that are silent to the app:

- Mobile is connected to cloud but BLE to glasses is down
- Glasses rejects the value (unsupported FOV on that hardware revision)
- Mobile app hasn't implemented the `CAMERA_FOV_SET` handler yet
- Glasses is mid-reconnect

The SDK JSDoc calls this out explicitly ("Fire-and-forget: the promise resolves once the message is sent") but the app developer has no option for confirmed delivery even if they want it.

### 6. Circular import in `@mentra/types` capability file (root cause of CI failures)

`cloud/packages/types/src/capabilities/mentra-display.ts` imported from `@mentra/sdk`:

```typescript
// Bug: @mentra/types cannot depend on @mentra/sdk (circular dep / missing dep)
import type {Capabilities} from "@mentra/sdk"
```

Every other capability file in the same directory uses the relative path:

```typescript
import type {Capabilities} from "../hardware"
```

This caused `@mentra/types`'s `prepare` script to fail during `bun install`, which cascaded into all 3 cloud CI jobs failing with `TS2307: Cannot find module '@mentra/sdk'`. **Fixed on branch `cloud/fix-dev-build-errors`.**

### 7. Mentra Display capability profile

The profile itself looks reasonable for a display-only device. Notable:

- `hasCamera: false`, `camera: null` — consistent with no-camera hardware
- Display: 640×200 resolution, green monochrome, 25° horizontal FOV, 2 displays, 5 text lines
- `hasIMU: true`, `imu: null` — IMU exists but raw data is not exposed to apps (head-up/down detection only)
- `hasWifi: false` — no WiFi, presumably BLE-only or wired

No validation issues with the profile values.

### 8. Unrelated changes bundled in

Two other changes landed in the same commits that are unrelated to camera FOV:

- **`ControllerTypes` enum** (`types/src/enums.ts`): adds `R1 = "Even Realities R1"`. No usage found yet in the codebase — appears to be forward declaration for an upcoming controller.
- **react-sdk `CapsuleMenuRect`**: new type + `getCapsuleMenuRect`/`useCapsuleMenu` exports for reading the capsule menu dimensions from the native webview bridge. Looks correct but untested.
- **Incident processor**: Linear ticket creation and email notifications commented out. This is a deliberate operational change, not a bug — but it was buried in the same diff.

## Conclusions

| Finding                                                                                    | Severity                                           | Fixable now?            | Recommendation                                                                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| TS2365 type mismatch in cloud handler (roiPosition)                                        | **Critical** — build broken                        | Yes                     | Fix: replace numeric check with `VALID_ROI_POSITIONS.includes(roiPosition)`. Already identified on branch. |
| FOV discrete vs continuous mismatch (SDK allows 82–118, cloud rejects non-[82,92,102,118]) | **High** — silent DX failure                       | Needs hardware decision | Clarify with hardware team what values are actually supported; align SDK validation with cloud             |
| Stale error message (`roiPosition must be 0-2`)                                            | **Medium** — wrong error text                      | Yes                     | Fix as part of bug 1 fix                                                                                   |
| No hardware capability check (hasCamera)                                                   | **Medium** — silent failure on camera-less devices | Yes                     | Add `userSession.glasses?.capabilities?.hasCamera` gate before forwarding                                  |
| No acknowledgment / response path                                                          | **Low** — by design, but undocumented risk         | Needs decision          | Decide if fire-and-forget is acceptable long-term; at minimum document failure modes in SDK JSDoc          |
| Circular import in `@mentra/types` mentra-display.ts                                       | **Critical** — was root CI failure                 | **Fixed**               | Done on `cloud/fix-dev-build-errors`                                                                       |
| Unrelated changes bundled (ControllerTypes, CapsuleMenuRect, incident processor)           | **Low** — review hygiene                           | N/A                     | No action needed, just flag for future PRs                                                                 |

## Next Steps

1. **Immediate**: Apply the two-line fix for bug 1 (TS2365 + stale error message) — this is on the current branch.
2. **Short-term**: Get hardware spec on supported FOV values — is it discrete `[82, 92, 102, 118]` or continuous `82–118`? Then align SDK and cloud validation.
3. **Short-term**: Add `hasCamera` capability check to `handleCameraFovSet`.
4. **Decide**: Is fire-and-forget acceptable for FOV control, or do we need a response path? If acceptable as-is, add explicit JSDoc warnings in the SDK about what can fail silently.
5. Produce `spec.md` once hardware decision on FOV range is made.
