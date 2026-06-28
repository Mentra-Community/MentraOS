# 019 - Reports Migration

**Status:** Implemented in branch

## What We Are Building

Cloud V2 reports are the single user/system reporting primitive for the
smartglasses OS. A report can be a manual bug report, an automatic runtime
report, or feature/general feedback. It is not a direct copy of the Cloud V1
`feedback + phoneState + logs` shape, and Cloud V1 under `cloud/` remains
untouched.

The system should let the mobile runtime say:

1. Something happened: a manual user report or an automatic OS/runtime trigger.
2. This is what was observed: expected behavior, actual behavior, and optional
   severity/priority metadata.
3. This is the runtime context: phone, glasses, settings, cloud status, running
   miniapps, and other OS state that the toolkit can collect consistently.
4. These are the evidence artifacts: phone logs, glasses logs, screenshots, and
   future state snapshots.

Cloud V2 adds a clean reports API under `cloud-v2/`, and mobile code reaches
it through `cloud-v2/packages/cloud-client/`.

## Ownership Boundary

Inside `@mentra/island` / toolkit:

- Collect runtime context from island-owned stores.
- Read the recent phone log ring buffer.
- Submit reports through `@mentra/cloud-client`.
- Add logs and screenshots as typed artifacts.
- Notify connected glasses with the report id so they can upload logs.
- Apply local automatic dedupe before creating duplicate cases.

Outside toolkit, in OEM/host UI:

- Present forms, wording, alerts, rating controls, screenshot picker UX, and
  success/error screens.
- Decide user-facing categories and trigger labels.
- Pass only the trigger, user-authored report/feedback content, optional
  contact email, and selected screenshots into toolkit.

## Cloud V2 API

Primary mobile/toolkit route:

```text
POST /api/client/reports
POST /api/client/reports/:reportId/artifacts
POST /api/client/reports/:reportId/complete
```

Compatibility log-ingress adapter for current glasses upload code:

```text
POST /api/incidents/:incidentId/logs
```

The adapter is only for glasses log upload after mobile has created a Cloud V2
report and relayed the id/base URL. It is not the primary mobile reports API,
and it does not replace or delete Cloud V1 endpoints.

### Submit Bug Report

```http
POST /api/client/reports
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "kind": "bug",
  "trigger": {
    "type": "manual",
    "source": "feedback_screen",
    "reason": "manual_bug_report",
    "sourceAppletPackageName": "com.example"
  },
  "report": {
    "expectedBehavior": "Video should play.",
    "actualBehavior": "Video failed.",
    "userSeverity": 4,
    "systemPriority": "high",
    "contactEmail": "user@example.com"
  },
  "context": {
    "app": {},
    "phone": {},
    "glasses": {},
    "runtime": {},
    "apps": {},
    "settings": {}
  },
  "dedupeKey": "gallery|video|com.example",
  "dedupeWindowMs": 90000
}
```

Response:

```json
{
  "reportId": "rep_...",
  "status": "collecting",
  "created": true
}
```

`created: false` means server-side dedupe found a recent open report with the
same user and `dedupeKey`.

### Add Logs

```http
POST /api/client/reports/:reportId/artifacts
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "type": "logs",
  "source": "phone",
  "entries": [
    {
      "timestamp": 1710000000000,
      "level": "info",
      "message": "..."
    }
  ]
}
```

Response:

```json
{
  "stored": 1
}
```

### Add Screenshots

```http
POST /api/client/reports/:reportId/artifacts
Authorization: Bearer <core access token>
Content-Type: multipart/form-data
```

Fields:

- `type`: `screenshot`
- `source`: `phone`
- `files`: one or more image files

Response:

```json
{
  "stored": 1
}
```

### Complete Report Collection

```http
POST /api/client/reports/:reportId/complete
Authorization: Bearer <core access token>
```

Response:

```json
{
  "status": "ready"
}
```

### Submit Automatic Report

```http
POST /api/client/reports
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "kind": "automatic",
  "trigger": {
    "type": "automatic",
    "source": "gallery_video",
    "reason": "gallery_video_on_error"
  },
  "report": {
    "expectedBehavior": "Video should play.",
    "actualBehavior": "Video failed.",
    "systemPriority": "high"
  },
  "context": {},
  "dedupeKey": "gallery|video",
  "dedupeWindowMs": 90000
}
```

Response:

```json
{
  "reportId": "rep_...",
  "status": "collecting",
  "created": true
}
```

### Submit Feedback

Feature requests and general feedback use the same reports collection and route:

```http
POST /api/client/reports
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "kind": "feedback",
  "feedback": {
    "type": "feature",
    "message": "..."
  },
  "context": {}
}
```

Response:

```json
{
  "reportId": "rep_...",
  "status": "ready",
  "created": true
}
```

### Glasses Log Ingress Adapter

```http
POST /api/incidents/:incidentId/logs
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "source": "glasses",
  "logs": [
    {
      "timestamp": 1710000000000,
      "level": "info",
      "message": "..."
    }
  ]
}
```

Response:

```json
{
  "stored": 1
}
```

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

- `trigger` answers why this case exists.
- `report` answers what was observed.
- `context` answers what the smartglasses OS/runtime looked like.
- `artifacts` make evidence extensible without adding a new route for every
  future evidence type.
- `userSeverity` and `systemPriority` avoid mixing subjective user pain with
  automatic report priority.
- `created` avoids a vague success boolean and makes dedupe explicit.
- `kind` avoids splitting feedback and bug reports into separate products when
  they are one reporting workflow with different payload shapes.

## Implementation Anchors

- `cloud-v2/packages/core/src/api/client/reports.api.ts`
- `cloud-v2/packages/core/src/services/report.service.ts`
- `cloud-v2/packages/core/src/models/report.model.ts`
- `cloud-v2/packages/cloud-client/src/modules/core/reports.ts`
- `mobile/modules/island/src/facades/reports.ts`
- `mobile/modules/island/src/utils/diagnosticContext.ts`
- `mobile/src/services/bugReport/bugReportSubmission.ts`
- `mobile/src/services/bugReport/bugReportCategorization.ts`
- `mobile/src/services/bugReport/automaticBugReport.ts`
- `mobile/src/app/miniapps/settings/feedback.tsx`
