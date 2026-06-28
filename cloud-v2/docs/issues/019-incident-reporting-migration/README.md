# 019 - Reports Migration

**Status:** Implemented in branch

## Goal

Cloud V2 reports are the single reporting primitive for the smartglasses OS.
They cover:

- `bug`: user-authored bug reports.
- `feedback`: user-authored feature/general feedback.
- `automatic`: runtime-detected failures.

This is a clean Cloud V2 implementation under `cloud-v2/`; Cloud V1 under
`cloud/` remains untouched.

## Boundary

Public OEM/host API:

- Host UI calls `toolkit.reports.submit({ kind: "bug", ... })`.
- Host UI calls `toolkit.reports.submit({ kind: "feedback", ... })`.
- Host UI owns screens, wording, navigation, rating controls, screenshot picker
  UX, alerts, and host-specific telemetry such as Sentry.

Island/toolkit internals:

- Island collects diagnostic context from runtime-owned stores.
- Island reads recent phone logs and attaches artifacts.
- Island submits through `@mentra/cloud-client`.
- Island notifies connected glasses with the report id so glasses can upload
  logs.
- Island owns automatic report detection, classification, local dedupe, and
  submission.

Public `toolkit.reports` intentionally does **not** accept
`kind: "automatic"`. Automatic reports remain valid Cloud V2 records, but they
are created through island-internal services.

## Cloud V2 Routes

Primary mobile/toolkit API:

```text
POST /api/client/reports
POST /api/client/reports/:reportId/artifacts
POST /api/client/reports/:reportId/complete
```

Glasses log-ingress adapter:

```text
POST /api/incidents/:incidentId/logs
```

The `/api/incidents/:incidentId/logs` route is not a mobile report-submission
alias. It exists so glasses-side log upload code can post logs after mobile has
created a Cloud V2 report and relayed the id/base URL.

## Mobile Flow

Manual bug report:

1. Host UI builds a manual trigger and user-authored report details.
2. Host calls `toolkit.reports.submit({ kind: "bug", trigger, report,
   screenshots? })`.
3. Island collects context, creates the report, attaches phone logs and optional
   screenshots, notifies glasses, and completes collection.

Feedback:

1. Host UI builds the feedback payload.
2. Host calls `toolkit.reports.submit({ kind: "feedback", feedback })`.
3. Island collects context and creates the feedback report.

Automatic report:

1. Island observes an OS/runtime condition.
2. The relevant island service calls the internal `submitAutomaticReport(...)`
   helper.
3. Island applies local dedupe, collects context/logs, submits to Cloud V2,
   notifies glasses, and completes collection.

## Implemented Automatic Sources

MentraJS crashloop:

- Trigger: `miniapp_crashloop` / `mentrajs_crashloop_disabled`.
- Detection: `MentraJSRouter` emits an island notification when the crash
  controller disables a miniapp.
- Submission: `mobile/modules/island/src/services/MentraJSCrashloopReportService.ts`.
- Host remains responsible for Sentry and user-facing alert copy in
  `mobile/src/services/mentraJsBootstrap.ts`.

Miniapp start failure:

- The old Cloud V1/RestComms online-miniapp start diagnostic was removed.
- Miniapps V2 do not use that start path, so there is no replacement automatic
  report.

Pairing boot timeout:

- Trigger: `pairing_loading` / `glasses_connect_timeout`.
- Detection/submission:
  `mobile/modules/island/src/facades/pairing.ts`.
- Host loading screen keeps UI/navigation and calls `toolkit.pairing.waitForReady(...)`.

Gallery media integrity:

- Trigger: `gallery_media_integrity` / `invalid_downloaded_media`.
- Submission:
  `mobile/modules/island/src/services/asg/GalleryMediaIntegrityReportService.ts`.
- Current checks cover download/storage integrity: missing files, zero-byte
  files, expected-size mismatches, and cheap photo/video container signatures.
- Host video playback errors are UI-local. A native decoder-level probe
  (`MediaMetadataRetriever`/`AVAsset` style) is a separate follow-up if we want
  to prove device-playability before the user opens a video.

Captions tester laptop report:

- Trigger: Android internal Crust event `captions_tester_incident`.
- Submission:
  `mobile/modules/island/src/services/CaptionsTesterReportService.ts`.
- The service emits the existing `CAPTIONS_TESTER_INCIDENT_RESULT` logcat marker.
- Cloud V2 transcript test logging is emitted from island via
  `mobile/modules/island/src/services/CloudTranscriptE2EMetrics.ts`, and the
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
- `dedupeKey`
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
- `created` makes server dedupe explicit.
- `kind` keeps bugs, feedback, and automatic diagnostics in one reporting
  product while preserving different payload shapes.

## Implementation Anchors

Cloud V2:

- `cloud-v2/packages/core/src/api/client/reports.api.ts`
- `cloud-v2/packages/core/src/services/report.service.ts`
- `cloud-v2/packages/core/src/models/report.model.ts`
- `cloud-v2/packages/cloud-client/src/modules/core/reports.ts`

Island/toolkit:

- `mobile/modules/island/src/facades/reports.ts`
- `mobile/modules/island/src/utils/diagnosticContext.ts`
- `mobile/modules/island/src/services/MentraJSCrashloopReportService.ts`
- `mobile/modules/island/src/facades/pairing.ts`
- `mobile/modules/island/src/services/asg/GalleryMediaIntegrityReportService.ts`
- `mobile/modules/island/src/services/CaptionsTesterReportService.ts`
- `mobile/modules/island/src/services/CloudTranscriptE2EMetrics.ts`

Host UI:

- `mobile/src/services/bugReport/bugReportSubmission.ts`
- `mobile/src/services/bugReport/bugReportCategorization.ts`
- `mobile/src/app/miniapps/settings/feedback.tsx`
