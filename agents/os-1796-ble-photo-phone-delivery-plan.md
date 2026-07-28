# OS-1796 — BLE photo to phone: deliver/save locally instead of webhook round-trip

Ticket: https://linear.app/mentralabs/issue/OS-1796
Status: plan (2026-07-28)

## Problem

Every SDK photo today has exactly one delivery mechanism: an HTTP multipart POST to
`webhookUrl`. The BLE path is a pure relay — the phone reassembles the image from the
glasses and then re-uploads it to the *same* webhook the glasses would have used
(`BlePhotoUploadService.uploadToWebhook`, Android `utils/BlePhotoUploadService.java:442`,
iOS `MentraLive.swift:417`). So a miniapp running on/near the phone gets its photo by
round-tripping the bytes through the internet back to itself ("webhook to self").

This blocks airgapped Mentra Live deployments and is the wrong default for future
BT-Classic glasses where bytes always land on the phone first. The miniapp should
receive the image data directly and decide what to do with it.

## Current state (mapped 2026-07-28)

**Glasses (`asg_client`)** — `PhotoCommandHandler.processPhotoCapture` routes on
`transferMethod` (`auto|direct|ble`) + `webhookUrl` + `save`:

| condition | destination |
|---|---|
| `save && webhookUrl empty` | local gallery only, no upload/BLE |
| `direct` | glasses HTTP POST → webhookUrl |
| `ble` | K900 file transfer → phone |
| `auto` | WiFi present → direct upload; else BLE; upload failure falls back to BLE |

**Phone (bluetooth-sdk)** — BLE reassembly completes in
`processAndUploadBlePhoto` (Android `MentraLive.kt:8777`, iOS `MentraLive.swift:4015`):
writes an app-private debug `.avif`, converts AVIF→JPEG preserving IMU EXIF, then
uploads to `webhookUrl`. The phone already holds the decoded bytes here — this is the
natural insertion point.

**Existing escape hatch** — `MentraPhotoReceiverModule` + `LocalPhotoUploadServer`
(ports 8787–8790): a consumer app starts an in-process HTTP server and passes its LAN
URL as `webhookUrl`. WiFi path: glasses POST over LAN. BLE path: Android rewrites the
host to `127.0.0.1` via `LocalPhotoReceiverRegistry.loopbackUploadUrlFor()`
(`BlePhotoUploadService.resolvePhoneRelayWebhookUrl:526`). **iOS has no loopback
rewrite** — its BLE relay posts to the literal LAN URL, which breaks off-WiFi.

**Mentra App / local miniapps** — `PhonePhotoCoordinator.ts:193` gets a presigned
cloud upload URL (`startManagedPhoto`), passes it as `webhookUrl`, awaits cloud-v2
`photo.ready {readUrl}`. So even local miniapps' BLE photos detour through R2.
cloud-v2 `photoOptionsSchema` accepts `{size, compress, saveToGallery, sound}` but the
runtime discards them (`camera.service.ts:76` — `void opts;`).

**Cloud miniapps (v1)** — webhook URL minted in `PhotoManager.ts:88-99`
(`customWebhookUrl` else `${app.publicUrl}/photo-upload`). Known bug found while
mapping: `saveToGallery` is accepted by the SDK but dropped from the message sent to
glasses (`PhotoManager.ts:135-149`).

**Camera-roll machinery already exists** (gallery sync only today):
`cameraRollExportCoordinator` → `CrustModule.saveToGalleryWithDate`
(Android `CrustModule.kt:534` MediaStore, iOS `CrustModule.swift:466` PHPhotoLibrary),
date-preserving, with permission/retry state machine.

## Goals

1. A first-class delivery option on `requestPhoto` meaning "give the bytes to the
   phone; do not upload to a webhook."
2. Optional save to the phone's camera roll as part of that delivery.
3. Local-miniapp photos are BLE-only and never touch Cloudflare: no presigned R2
   upload/read URLs, no cloud round trip anywhere in the request path — which makes
   airgapped Mentra Live work by construction.
4. iOS/Android parity, including fixing the existing iOS loopback-rewrite gap.

## Non-goals (follow-ups, not this ticket)

- Changing the *default* path for cloud miniapps (v1 `PhotoManager`). Flipping the
  default to phone-delivery is a separate, riskier change once the option ships.
- Raw-bytes-over-websocket delivery to cloud miniapps (only precedent is the
  deprecated base64 `photo_taken` broadcast).
- Fixing the dropped `saveToGallery` in v1 `PhotoManager` (file separately; one-line
  plumb but needs glasses-side confirmation).

## Design

### New API surface (bluetooth-sdk)

A flat `delivery?: "webhook" | "phone"` flag would multiply invalid states
(`delivery: "phone"` + `webhookUrl` set; `delivery: "webhook"` with no URL;
`transferMethod: "direct"` with phone delivery). The existing `save` flag has the
same disease in disguise: it is not orthogonal to destination — on the glasses,
`save=true` + empty `webhookUrl` is the magic combo that routes to
*glasses-local-only capture* (`PhotoCommandHandler.java:362`, checked before any
transfer-method branch), so `save` secretly encodes a third destination. Model all
of it as one discriminated union so every invalid combination is unrepresentable:

```ts
type PhotoDestination =
  | {
      kind: "webhook";
      url: string;                       // required — no URL-less webhook state
      authToken?: string;
      transferMethod?: PhotoTransferMethod; // auto|direct|ble — only meaningful here
      keepOnGlasses?: boolean;           // also keep a copy in the glasses gallery
    }
  | {
      kind: "phone";
      saveToCameraRoll?: boolean;        // only exists on this arm
      keepOnGlasses?: boolean;           // see wire-mapping note below
      // no url/authToken/transferMethod: phone delivery always rides BLE
    }
  | {
      kind: "glasses";                   // gallery-only capture; no transfer at all
      // nothing to configure: this IS "save on glasses", so no keepOnGlasses flag
    };

interface PhotoRequestParams {
  destination: PhotoDestination;
  size?: ...; compress?: ...; sound?: ...; // unchanged capture options
  // `save` is deleted — its meanings are absorbed by the union
}
```

Wire mapping (the `take_photo` JSON keeps its current fields; only the SDK-side
type changes):
- `{kind: "webhook", keepOnGlasses}` → `webhookUrl` + `save: keepOnGlasses`.
  Valid today: with a non-empty webhook the glasses capture into the permanent
  gallery tree *and* deliver (`PhotoCommandHandler.java:303`).
- `{kind: "glasses"}` → `save: true`, no `webhookUrl`, no `bleImgId` — exactly
  today's local-save route, now expressed explicitly instead of via the magic combo.
- `{kind: "phone"}` → `transferMethod: "ble"` + `bleImgId`, no `webhookUrl`,
  `save: keepOnGlasses`. **Caveat:** with `keepOnGlasses: true` this trips the
  `:362` local-save-only check on pre-fix firmware (the BLE transfer would never
  start). Fix is a one-line asg_client routing change — gate `:362` on `bleImgId`
  being empty too — shipped as PR 2a ahead of the SDK change. Glasses OTA updates
  are mandatory now, so no legacy-firmware compat handling is needed in the SDK;
  the only requirement is release ordering (2a's firmware rolls out before 2b
  reaches users).

Back-compat: keep the existing top-level `webhookUrl`/`authToken`/`transferMethod`/
`save` fields as deprecated inputs; when `destination` is absent the SDK normalizes
them — `webhookUrl` present → `{kind: "webhook", keepOnGlasses: save}`;
`save: true` + no webhook → `{kind: "glasses"}` — and rejects requests that mix the
old fields with a `destination`.

### Remaining invalid-state audit of `PhotoRequestParams`

Full sweep of the current type (`BluetoothSdk.types.ts:573`) for other
incoherent combinations:

- **Killed by the union already:** `webhookUrl`/`authToken` are `string | null`
  *required-nullable* today, so `authToken` set with `webhookUrl: null` is
  representable and meaningless. The webhook arm (required `url`, optional
  `authToken`) removes it. Verified non-issue: `bleImgId` is not in the TS surface —
  it's generated natively — so no `ble`-without-`bleImgId` state exists at the API
  layer.
- **Exposure/capture cluster (in scope for PR 2b, same disease):** the type carries
  `exposureTimeNs`, `iso` ("only used when exposureTimeNs enables manual exposure"),
  `aeExposureDivisor`/`isoCap` (AE-metered "scan mode"), and `zsl`/`mfnr` ("forced
  off for manual/scan stills"). Today `iso` without `exposureTimeNs` is silently
  ignored, `zsl`/`mfnr` with manual exposure are silently overridden, and
  `aeExposureDivisor` (metered) with `exposureTimeNs` (fixed) is contradictory.
  Fold into a second small union while we're breaking the type anyway:

  ```ts
  exposure?:
    | { kind: "auto"; zsl?: boolean; mfnr?: boolean }
    | { kind: "manual"; timeNs: number; iso?: number }
    | { kind: "scan"; aeExposureDivisor?: number; isoCap?: number };
  ```

  (`noiseReduction`/`edgeEnhancement`/isp gains stay flat — glasses-side
  best-effort, no cross-field constraints.)
- **`compress` vs transport (decide in PR 2b):** the BLE path re-encodes via
  `BlePhotoEncoders` (AVIF/fast-JPEG) and the phone transcodes to JPEG q90
  regardless of `compress` — so `compress: "none"` on the phone arm (or any
  BLE-forced transfer) is a promise the pipeline can't keep, and `size: "max"` over
  BLE is technically valid but slow. Proposal: the phone arm omits `compress`
  entirely (transport codec policy governs); on the webhook arm it keeps today's
  meaning for direct upload and is documented as advisory when the BLE fallback
  kicks in. Type-level where possible, documented where the fallback makes it
  runtime-dependent.
- **Loopback URL + `transferMethod: "direct"` (validation, not types):**
  `{kind: "webhook", url: "http://127.0.0.1:...", transferMethod: "direct"}` is
  unreachable by construction — the glasses can't hit the phone's loopback; the
  `LocalPhotoReceiverRegistry` rewrite only exists on the BLE relay. The URL's
  loopback-ness isn't expressible in types, so this one is a runtime validation:
  reject loopback/link-local URLs with `direct`, and keep the existing
  force-BLE-for-loopback behavior for `auto`.

`kind: "phone"` semantics:
- Result event carries the photo itself: extend the existing `photo_response`
  terminal event with `{ requestId, fileUri, mimeType, byteCount, savedToCameraRoll? }`.
  The file is written to app-private storage (reuse the `MentraLive_Images` dir that
  already receives the debug copy; write the *converted JPEG*, not the raw AVIF, and
  stop double-writing the debug `.avif` for this mode).

### Native behavior per route

- **BLE route** (the common no-WiFi case): branch in `processAndUploadBlePhoto`
  (`MentraLive.kt:8777` / `MentraLive.swift:4015`): convert AVIF→JPEG as today, skip
  `uploadToWebhook`, persist JPEG, optionally `CrustModule.saveToGalleryWithDate`,
  emit terminal success with `fileUri`. No HTTP at all — do *not* route through the
  loopback local-server for this mode; handing bytes straight to the event is simpler
  and works identically on iOS.
- **WiFi-direct route**: the glasses need *some* HTTP destination. With the union,
  `kind: "phone"` simply has no direct route — the SDK builds the `take_photo`
  command (`MentraLive.kt:5506`) with `transferMethod: "ble"` and no `webhookUrl`.
  Rationale: no dependency on phone+glasses sharing a LAN, works airgapped by
  construction, and BLE-photo latency is already acceptable (that's the whole
  fallback path). Keeps the change surface phone-side only — **no asg_client
  firmware change required** except the one-line `:362` routing gate needed for
  `keepOnGlasses` on the phone arm (see wire mapping above). (Rejected for v1: auto-starting
  `LocalPhotoUploadServer` and passing its LAN URL as the webhook — faster on WiFi
  but needs LAN co-presence, LAN-IP discovery, and the iOS loopback fix first. Can be
  layered in later as a transparent optimization without API change.)
- **Camera roll**: gate on the existing `MediaLibraryPermissions` flow; if permission
  is denied, still deliver `fileUri` and set `savedToCameraRoll: false` with an error
  detail rather than failing the photo.

### iOS loopback parity fix (independent, do first)

Port `LocalPhotoReceiverRegistry.loopbackUploadUrlFor()` behavior to iOS
`BlePhotoUploadService` so a BLE relay targeting the app's own
`LocalPhotoUploadServer` rewrites to `127.0.0.1`. This fixes the existing
photo-receiver escape hatch off-WiFi on iOS regardless of the new option.

### Miniapp SDK / engine: BLE path off the Cloudflare relay (default, not opt-in)

Today `PhonePhotoCoordinator.ts:193` always mints a presigned R2 pair via
`startManagedPhoto` and hands the `uploadUrl` down as `webhookUrl` — so a photo that
arrives over BLE gets uploaded from the phone to Cloudflare R2 just so the miniapp
can fetch it back via `readUrl`. That relay is removed for the BLE path:

**Decision (2026-07-28): local-miniapp photos are BLE-only.** No WiFi-direct path,
no `startManagedPhoto`, no R2 presign — ever — for local miniapps.

- **One transport.** The coordinator always requests
  `destination: {kind: "phone"}`; the glasses never attempt a WiFi upload for these
  requests (the union forces `transferMethod: "ble"`). No mint means no cloud round
  trip in the request path, so airgap works by construction and there is no
  auto-mode ambiguity, no prediction, no fallback bookkeeping.
- **One completion path.** When the JPEG lands on the phone, the coordinator
  completes through the runtime's existing local blob path (`camera.api.ts:161-178`
  PUT/POST) and the miniapp receives `photo.ready {requestId, readUrl}` with a
  runtime-served local URL. The miniapp contract ("fetch readUrl") is unchanged;
  only the URL's origin differs. The storage-webhook completion route
  (`/api/camera/storage-events`) simply never fires for local miniapps.
- **Accepted trade-off:** heavy captures (`size: "max"`) ride BLE too — slower
  transfer, and the BLE encode/transcode pipeline governs final quality. Document
  this in the miniapp SDK photo options. If a real need for fast full-quality
  delivery materializes, a WiFi-direct perf path (glasses → presigned URL, lazy
  local completion as its fallback net) is a well-understood follow-up — deliberately
  not built now.
- cloud-v2 dead code this exposes: with no local-miniapp R2 uploads, audit whether
  `miniapp-sdk-photo-storage.service.ts` / the storage-events route have remaining
  callers before removing anything (cloud-hosted miniapps are out of scope here).
- cloud-v2 `photoOptionsSchema` plumbing (`void opts;` at `camera.service.ts:76`)
  still needs fixing in this PR so `saveToGallery`/size/compress survive, and to add
  the phone-side `saveToCameraRoll` option — but no `delivery` option is exposed to
  miniapps: local-vs-R2 is a transport consequence, not an API choice.
- Airgapped devices follow from the default: no WiFi upload path → BLE transport →
  local completion. A device-level "force BLE / airgap" setting can pin the transport
  decision but needs no new delivery API.

## Milestones / PR breakdown

1. **PR 1 — iOS loopback rewrite parity** (bluetooth-sdk/ios). Small, standalone,
   fixes an existing bug. On-device iOS verification with the example app's photo
   receiver, phone off WiFi.
2. **PR 2a — asg_client routing gate** (one line + test): local-save-only route at
   `PhotoCommandHandler.java:362` additionally requires an empty `bleImgId`, so
   `save: true` + BLE transfer coexist. Ship ahead of PR 2b via the normal firmware
   train; no behavior change for any request shape phones send today.
3. **PR 2b — `destination` union (webhook/phone/glasses) + `saveToCameraRoll` in
   bluetooth-sdk** (types + Android + iOS + example app toggle, with
   deprecated-field normalization replacing `save`). Same PR takes the rest of the
   invalid-state audit: the `exposure` sub-union, `compress` scoped to the webhook
   arm, and loopback-URL + `direct` runtime rejection. `kind: "phone"` always rides
   BLE; phone-arm `keepOnGlasses` requires PR 2a's firmware, guaranteed by
   mandatory OTA — releases only after 2a's firmware is rolled out. Unit tests for
   the request-builder (union → `take_photo` JSON, old-field normalization incl.
   `save`, mixed old/new rejection) and the terminal-event shape; hardware
   verification both platforms (photo lands in `fileUri`, camera roll opt-in works,
   permission-denied degrades gracefully, phone-arm `keepOnGlasses` leaves a
   gallery copy). Version-bump the SDK per the usual dev-release flow.
4. **PR 3 — local-miniapp photos BLE-only, off the R2 relay entirely**
   (`PhonePhotoCoordinator`, cloud-v2 `photoOptionsSchema`/`camera.service`,
   cloud-client). Coordinator always uses `{kind: "phone"}`; `startManagedPhoto`
   and the R2 presign are removed from the local-miniapp flow; completion via the
   runtime local blob path. Test with a local miniapp with networking disabled
   (airgap simulation) and confirm `photo.ready` readUrl is local-origin and no
   cloud request is made at any point in the flow.
5. **Follow-ups (separate tickets)**: LAN-receiver optimization for WiFi-present
   phone delivery; flipping the default delivery for BT-Classic glasses; v1
   `PhotoManager` `saveToGallery` drop; deciding the cloud-miniapp story (presigned
   URL vs webhook default).

## Test plan

- Unit: `take_photo` command builder (`kind: "phone"` forces `ble`, omits webhook
  fields; deprecated-field normalization; mixed old/new rejection); BLE completion
  branch (upload skipped, event payload); camera-roll gating.
- Maestro/E2E: photo request from example app with `destination: {kind: "phone"}`,
  assert `photo_response` carries a readable `fileUri`; local miniapp photo asserts
  no request ever hits an R2/cloud host when transport is BLE.
- Hardware (Mentra Live, both phone platforms): BLE-only (WiFi off on glasses and
  phone), WiFi-on (verify forced-BLE still delivers), camera-roll save with
  permission granted/denied, EXIF UserComment preserved after conversion.
- Airgap: local miniapp photo round-trip with cloud unreachable.

## Decisions (all resolved 2026-07-28)

1. **Pre-PR-2a firmware compat: moot.** Glasses OTA updates are mandatory now, so
   the SDK carries no legacy-firmware handling for
   `{kind: "phone", keepOnGlasses: true}`. The only requirement is release
   ordering: PR 2a's firmware rolls out before PR 2b reaches users.
2. **Terminal event payload: `fileUri` only.** Keep bridge/event messages as tiny
   as possible — no inline base64, no size-threshold behavior. The file must exist
   anyway (camera-roll export, retention), and consumers that want bytes read the
   file.
3. **Local-miniapp photos are BLE-only.** No mint, no WiFi-direct, no prediction;
   single completion path via the runtime local blob. A WiFi-direct perf path for
   heavy captures is a possible future follow-up, deliberately not built now.
4. **Retention: SDK-owned sweep of `MentraLive_Images`.** Phone-delivered JPEGs
   stay in `MentraLive_Images`; the SDK owns cleanup (age TTL ~24h + total-size
   cap, swept on session start), documented as "`fileUri` valid for at least N
   hours; copy it if you need it longer." Legacy debug `.avif` copies fold into
   the same sweep; camera-roll copies are the user's and are never touched.
   Runtime local blobs backing `readUrl` get a deliberate short TTL, documented in
   the miniapp SDK.
