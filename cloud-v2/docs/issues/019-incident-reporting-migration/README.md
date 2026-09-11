# 019 - Reports Migration

**Status:** Implemented / partial

## Goal

Cloud V2 reports are the single reporting primitive for the smartglasses OS.
They cover:

- `bug`: user-authored bug reports.
- `feedback`: user-authored feature/general feedback.
- `automatic`: runtime-detected failures.

This is the Cloud V2 reporting implementation. The retired Cloud V1 source has
been removed from the repository.

## Boundary

Public OEM/host API:

- Host UI calls `engine.reports.submit({ kind: "bug", ... })`.
- Host UI calls `engine.reports.submit({ kind: "feedback", ... })`.
- Host UI owns screens, wording, navigation, rating controls, screenshot picker
  UX, alerts, and host-specific telemetry such as Sentry.

Island/engine internals:

- Island collects diagnostic context from runtime-owned stores.
- Island reads recent phone logs and attaches artifacts.
- Island submits through `@mentra/cloud-client`.
- Island notifies connected glasses with the report id so glasses can upload
  logs.
- Island owns automatic report detection, classification, local throttling, and
  submission.

Public `engine.reports` intentionally does **not** accept
`kind: "automatic"`. Automatic reports remain valid Cloud V2 records, but they
are created through island-internal services.

## Cloud V2 Routes

Primary mobile/engine API:

```text
POST /api/client/reports
POST /api/client/reports/:reportId/artifacts
POST /api/client/reports/:reportId/complete
```

There is deliberately no `/api/incidents` compatibility mount in Cloud V2.
Glasses logs are report artifacts and use the same artifact endpoint as phone
logs and screenshots.

## Mobile Flow

Manual bug report:

1. Host UI builds a manual trigger and user-authored report details.
2. Host calls `engine.reports.submit({ kind: "bug", trigger, report,
   screenshots? })`.
3. Island collects context, creates the report, attaches phone logs and optional
   screenshots, notifies glasses, and completes collection.

Feedback:

1. Host UI builds the feedback payload.
2. Host calls `engine.reports.submit({ kind: "feedback", feedback })`.
3. Island collects context and creates the feedback report.

Automatic report:

1. Island observes an OS/runtime condition.
2. The relevant island service calls the internal `submitAutomaticReport(...)`
   helper.
3. Island applies local throttling, collects context/logs, submits to Cloud V2,
   notifies glasses, and completes collection.

## Implemented Automatic Sources

MentraJS crashloop:

- Trigger: `miniapp_crashloop` / `mentrajs_crashloop_disabled`.
- Detection: `MentraJSRouter` emits an island notification when the crash
  controller disables a miniapp.
- Submission: `mobile/modules/engine/src/services/MentraJSCrashloopReportService.ts`.
- Host remains responsible for Sentry and user-facing alert copy in
  `mobile/src/services/mentraJsBootstrap.ts`.

Miniapp start failure:

- The old Cloud V1/RestComms online-miniapp start diagnostic was removed.
- Miniapps V2 do not use that start path, so there is no replacement automatic
  report.

Pairing boot timeout:

- Trigger: `pairing_loading` / `glasses_connect_timeout`.
- Detection/submission:
  `mobile/modules/engine/src/facades/pairing.ts`.
- Host loading screen keeps UI/navigation and calls `engine.pairing.waitForReady(...)`.

Gallery media integrity:

- Trigger: `gallery_media_integrity` / `invalid_downloaded_media`.
- Submission:
  `mobile/modules/engine/src/services/asg/GalleryMediaIntegrityReportService.ts`.
- Current checks cover download/storage integrity: missing files, zero-byte
  files, expected-size mismatches, and cheap photo/video container signatures.
- Host video playback errors are UI-local. A native decoder-level probe
  (`MediaMetadataRetriever`/`AVAsset` style) is a separate follow-up if we want
  to prove device-playability before the user opens a video.

Captions tester laptop report:

- Trigger: Android internal Crust event `captions_tester_incident`.
- Submission:
  `mobile/modules/engine/src/services/CaptionsTesterReportService.ts`.
- The service emits the existing `CAPTIONS_TESTER_INCIDENT_RESULT` logcat marker.
- Cloud V2 transcript test logging is emitted from island via
  `mobile/modules/engine/src/services/CloudTranscriptE2EMetrics.ts`, and the
  laptop monitor records the marker in
  `mobile/e2e-tests/scripts/live_word_monitor.py`.

## Data Model

`reports`:

- `reportId`
- `mentraUserId`
- `kind`: `bug`, `automatic`, or `feedback`
- `trigger`
- `report`
- `feedback`
- `context`
- `artifacts`
- `status`: `collecting`, `ready`, or `closed`

## Why This Shape

- `trigger` answers why the case exists.
- `report` answers what was observed.
- `context` answers what the smartglasses OS/runtime looked like.
- `artifacts` keep evidence extensible without adding a route for every future
  evidence type.
- `userSeverity` and `systemPriority` avoid mixing subjective user pain with
  runtime priority.
- Automatic trigger throttling stays local to island services. Cloud V2 creates
  one report record for each submit request.
- `kind` keeps bugs, feedback, and automatic diagnostics in one reporting
  product while preserving different payload shapes.

## Implementation Anchors

Cloud V2:

- `cloud-v2/packages/core/src/api/client/reports.api.ts`
- `cloud-v2/packages/core/src/services/report.service.ts`
- `cloud-v2/packages/core/src/models/report.model.ts`
- `cloud-v2/packages/cloud-client/src/modules/core/reports.ts`

Island/engine:

- `mobile/modules/engine/src/facades/reports.ts`
- `mobile/modules/engine/src/utils/diagnosticContext.ts`
- `mobile/modules/engine/src/services/MentraJSCrashloopReportService.ts`
- `mobile/modules/engine/src/facades/pairing.ts`
- `mobile/modules/engine/src/services/asg/GalleryMediaIntegrityReportService.ts`
- `mobile/modules/engine/src/services/CaptionsTesterReportService.ts`
- `mobile/modules/engine/src/services/CloudTranscriptE2EMetrics.ts`

Host UI:

- `mobile/src/services/bugReport/bugReportSubmission.ts`
- `mobile/src/services/bugReport/bugReportCategorization.ts`
- `mobile/src/app/miniapps/settings/feedback.tsx`

## Cloud V2 Glasses Log Auth

Decision:

- Treat glasses log upload as a Cloud V2 core/web-service operation owned by the
  user, not by a miniapp package.
- Do not add legacy Cloud V1 compatibility auth to Cloud V2.
- Break old-glasses HTTP upload compatibility if needed. Incident log upload from
  older glasses is fire-and-forget and currently unreliable; losing that upload is
  acceptable during the clean Cloud V2 migration.
- Keep the BLE command surface compatible where possible: command type
  `auth_token`, payload field `coreToken`, command type `upload_incident_logs`,
  payload field `incidentId`, and optional `apiBaseUrl`.

Why keep the BLE names:

- Mentra Live already uses `core_token` / `coreToken` as the setting and BLE
  bridge field for the bearer credential it sends to ASG.
- ASG treats the value as an opaque bearer token. The command name does not need
  to encode whether the token is legacy Cloud V1 or Cloud V2.
- Renaming the BLE field would create unnecessary command compatibility churn.
  We can update comments/docs to say that `coreToken` now carries the Cloud V2
  user access token for Cloud V2-capable glasses.

Token lifecycle:

- Cloud V1 `RestComms.exchangeToken(...)` returns an old core token that is
  still needed by remaining Cloud V1 mobile calls and WebSocket setup, but it
  must stay private to those legacy clients.
- Cloud V2 core access tokens are minted by `@mentra/cloud-client`, live in
  memory only, expire after 1 hour, and are refreshed through a persisted
  30-day refresh token.
- Island syncs the current Cloud V2 access token into the existing Bluetooth
  `core_token` setting slot on startup and again before notifying glasses about
  a report. The setting is volatile: it is not saved locally and is not written
  back to Cloud V1 settings.
- Stale server-loaded `core_token` values are ignored during mobile boot so an
  old Cloud V1 token cannot overwrite the Cloud V2 bearer sent to glasses.

Target HTTP contract:

```text
POST /api/client/reports/:reportId/artifacts
Authorization: Bearer <cloud-v2 user access token>
Content-Type: application/json

{
  "type": "logs",
  "source": "glasses" | "glasses_firmware",
  "entries": [...]
}
```

This reuses the existing Cloud V2 artifact route instead of keeping
`/api/incidents/:incidentId/logs`. Logs are report artifacts, and this keeps one
Cloud V2 ingestion surface for phone logs, glasses logs, and future log sources.

Implementation steps:

1. Mobile/island obtains the Cloud V2 core access token from `@mentra/cloud-client`
   after auth exchange, using the existing `cloud.auth.getCoreToken()` surface.
2. Mentra Live continues to send the token to ASG through the existing
   `auth_token` / `coreToken` BLE message, but the token value is the Cloud V2
   access token.
3. Island syncs that Cloud V2 access token into the Bluetooth/ASG settings slot
   currently named `core_token`. The name remains for BLE compatibility, but the
   value must come from Cloud V2. Any remaining RestComms/Cloud V1 token sync must
   be removed or gated so it cannot overwrite the Cloud V2 token sent to glasses.
4. Island continues to call `BluetoothSdk.sendIncidentId(reportId, coreUrl)` after
   creating a report. The command stays fire-and-forget.
5. ASG updates direct Wi-Fi log upload:
   - `UploadIncidentLogsCommandHandler` posts Android/logcat logs to
     `/api/client/reports/:reportId/artifacts`.
   - `BesLogManager` posts BES firmware logs to the same route.
   - Payload changes from `{ source, logs }` to `{ type: "logs", source,
     entries }`.
6. Phone BLE fallback relay updates to the same route and payload:
   - Android `IncidentLogBleUploadService`.
   - iOS `MentraLive.uploadBleIncidentLogRelay`.
7. Cloud V2 removes the `/api/incidents/:incidentId/logs` adapter route; ASG and
   BLE relay use only the artifact route.
8. Preserve failure behavior:
   - Mobile report submission must not wait for glasses logs.
   - ASG direct upload stays asynchronous.
   - BLE fallback upload stays best-effort.
   - Report completion may happen before glasses logs arrive; the artifact route
     must continue accepting logs for an existing user-owned report after status
     becomes `ready`.

Validation:

- Unit/type checks:
  - `cd cloud-v2 && bun run typecheck`
  - `cd mobile && bun compile`
  - `cd mobile/modules/engine && bun run build`
- Android compile check after ASG edits:
  - `./scripts/check-android-compile.sh asg`
- Manual/log validation:
  - File a report from mobile.
  - Confirm ASG receives `upload_incident_logs`.
  - Confirm ASG direct HTTP request targets
    `/api/client/reports/:reportId/artifacts`.
  - Confirm request uses a Cloud V2 access token bearer.
  - Confirm Cloud V2 report contains `phone`, `glasses`, and
    `glasses_firmware` log artifacts when available.
