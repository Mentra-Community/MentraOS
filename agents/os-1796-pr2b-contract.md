# OS-1796 PR 2b — implementation contract (destination union)

Parent plan: `agents/os-1796-ble-photo-phone-delivery-plan.md` (Design section).
Updated 2026-09-11: the `exposure` union is deferred (flat exposure fields are
unchanged and not deprecated); the firmware gate (#3616) keys on `transferMethod`.
This file pins the exact cross-layer contract so the TS, Android, and iOS changes
compose. Branch: `pferreira/os-1796-photo-destination-union` (stacked on the iOS
loopback PR).

## Public TS surface (`mobile/modules/bluetooth-sdk/src/BluetoothSdk.types.ts`)

```ts
export type PhotoDestination =
  | {
      kind: "webhook"
      url: string
      authToken?: string
      /** auto|direct|ble — only meaningful for webhook delivery. */
      transferMethod?: PhotoTransferMethod
      /** Also keep a copy in the glasses gallery. */
      keepOnGlasses?: boolean
      /** Compression for the webhook upload; advisory when the BLE fallback kicks in. */
      compress?: PhotoCompression
    }
  | {
      kind: "phone"
      /** Also export the delivered photo to the OS camera roll. */
      saveToCameraRoll?: boolean
      /** Also keep a copy in the glasses gallery (requires the PR-2a firmware gate). */
      keepOnGlasses?: boolean
    }
  | {
      kind: "glasses"
    }

```

`PhotoRequestParams` gains `destination?: PhotoDestination`. The existing flat
delivery fields (`webhookUrl`, `authToken`, `transferMethod`, `save`, `compress`)
stay but are `@deprecated`-tagged. All other flat fields (`size`, `mode`, `sound`,
`exposureTimeNs`, `iso`, `aeExposureDivisor`, `isoCap`, `zsl`, `mfnr`,
`noiseReduction`, `edgeEnhancement`, `ispDigitalGain`, `ispAnalogGain`,
`requestId`, `appId`) are unchanged.

## TS normalization (new pure function, unit-tested)

`normalizePhotoRequestParams(params) -> NativePhotoRequest` in a new
`src/photoRequest.ts` (exported for tests; called by the `requestPhoto` public
binding before the native call).

Rules:
- `destination` present AND any of `webhookUrl`/`authToken`/`transferMethod`/`save`
  set (non-null/undefined) → **throw** `TypeError` (mixed old/new).
- `destination` + flat `compress` is also mixed (compress now lives on the
  webhook arm).
- No `destination` → derive: `webhookUrl` non-empty →
  `{kind: "webhook", url, authToken, transferMethod, keepOnGlasses: !!save, compress}`;
  else `save` true → `{kind: "glasses"}`; else → **throw** (today's shape with no
  webhook and no save was never valid for the public module).

- Webhook arm validation: phone-only host (`127.0.0.0/8`, `::1`, `localhost`,
  `169.254.*`, `fe80::/10`) + `transferMethod: "direct"` → throw (glasses can
  never reach it).

## Native bridge dict (`NativePhotoRequest`, what the native `requestPhoto` receives)

Existing shape plus:
- `destinationKind: "webhook" | "phone" | "glasses"` (required, new)
- `saveToCameraRoll: boolean` (new, only meaningful for `phone`)
- `webhookUrl`/`authToken`: null unless `webhook`
- `transferMethod`: `"ble"` for `phone`; caller value (default `"auto"`) for
  `webhook`; `"auto"` for `glasses` (the glasses archival route consults it: any
  value but `"ble"` keeps `save`+no-webhook on the archival path, and `"ble"` is
  the phone arm's explicit delivery signal — PR 2a / #3616)
- `save`: `keepOnGlasses` for webhook/phone arms; `true` for `glasses`
- exposure fields pass through flat, unchanged

## Native behavior (Android `MentraLive.kt`, iOS `MentraLive.swift`)

Per `destinationKind`:
- `webhook`: exactly today's behavior (bleImgId minted, BLE fallback relays to
  webhook, loopback rewrite applies).
- `glasses`: build `take_photo` with `save: true`, **no** `webhookUrl`, **no**
  `bleImgId`, do not register a `BlePhotoTransfer`. Resolve the JS promise from
  the existing ack/terminal path (photo stays on glasses; response carries no
  fileUri).
- `phone`: mint `bleImgId` and register the transfer as today, but build
  `take_photo` with `transferMethod: "ble"`, `save: keepOnGlasses`, **no**
  `webhookUrl`/`authToken`. On BLE completion (Android
  `processAndUploadBlePhoto`, iOS call site of
  `BlePhotoUploadService.processAndUploadPhoto`):
  - convert to JPEG preserving EXIF exactly as today;
  - write to `<appFiles>/MentraLive_Images/PHONE_<requestId>_<ts>.jpg`, with the
    requestId reduced to `[A-Za-z0-9._-]` (max 64 chars) for the file name (this IS
    the deliverable, not a debug copy; skip the raw `.avif` debug write for this
    mode);
  - if `saveToCameraRoll`: export to the OS photo library **implemented inside
    this module** (Android `MediaStore` insert; iOS `PHPhotoLibrary`), no
    dependency on the crust module. The SDK never prompts for permission inside
    a capture (a dialog would sit inside the photo deadline); the app requests
    add-only Photos / storage access up front. Undecided or denied → still a
    success, with `savedToCameraRoll: false` and `cameraRollError: <short reason>`;
  - emit the terminal success `photo_response` event with
    `{requestId, fileUri, mimeType: "image/jpeg", byteCount, savedToCameraRoll,
    cameraRollError?}` — fileUri only, never inline image data;
  - never call the webhook upload service.

## Retention sweep (both native platforms)

On transport init/connect (once per session): delete files in
`MentraLive_Images` older than 24h, then oldest-first until the dir is ≤ 256 MB.
Applies to all files there (including legacy `BLE_*.avif` debug copies).
Constants live with the other photo constants. The TS type documents exactly
that: normally kept 24h, but the size cap can evict younger files after a burst
of large captures — copy to keep.

## Terminal event type (TS)

`PhotoSuccessResponseEvent` gains optional `fileUri?: string`,
`mimeType?: string`, `byteCount?: number`, `savedToCameraRoll?: boolean`,
`cameraRollError?: string`.

## iOS Photos-permission plist note

Camera-roll export needs `NSPhotoLibraryAddUsageDescription`. The SDK must
degrade gracefully when absent (treat as permission denied); the example app's
config gains the key.

## Example app

`modules/bluetooth-sdk/example/App.tsx`: add a "deliver to phone" toggle +
"save to camera roll" toggle that sends
`destination: {kind: "phone", saveToCameraRoll}` and renders the returned
`fileUri` (Image preview) instead of relying on the photo receiver.

## Tests

- TS: jest unit tests for `normalizePhotoRequestParams` (arm mapping, legacy
  derivation incl. `save`-only → glasses, mixed-field throws, loopback+direct
  throw, flat exposure pass-through) colocated per module test convention.
- Native: compile checks (`./scripts/check-android-compile.sh bluetooth-sdk`,
  `swiftc -parse` at minimum). Hardware verification per plan before merge.
