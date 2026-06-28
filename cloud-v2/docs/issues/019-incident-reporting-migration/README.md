# 019 - Incident Reporting Migration

**Status:** Implemented in branch

## What We Are Building

Cloud V2 incidents are diagnostic cases for smartglasses OS failures. They are
not generic feedback rows and they are not a direct copy of the Cloud V1
`feedback + phoneState + logs` shape.

The system should let the mobile runtime say:

1. Something happened: a manual user report or an automatic OS/runtime trigger.
2. This is what was observed: expected behavior, actual behavior, and optional
   severity/priority metadata.
3. This is the runtime context: phone, glasses, settings, cloud status, running
   miniapps, and other OS state that the toolkit can collect consistently.
4. These are the evidence artifacts: phone logs, glasses logs, screenshots, and
   future state snapshots.

Cloud V1 under `cloud/` remains untouched. Cloud V2 adds a clean incident API
under `cloud-v2/`, and mobile code reaches it through
`cloud-v2/packages/cloud-client/`.

## Ownership Boundary

Inside `@mentra/island` / toolkit:

- Collect runtime context from island-owned stores.
- Read the recent phone log ring buffer.
- Create incidents through `@mentra/cloud-client`.
- Add logs and screenshots as typed artifacts.
- Notify connected glasses with the incident id so they can upload logs.
- Apply local automatic dedupe before creating duplicate cases.

Outside toolkit, in OEM/host UI:

- Present forms, wording, alerts, rating controls, screenshot picker UX, and
  success/error screens.
- Decide user-facing categories and trigger labels.
- Pass only the trigger, report text, optional contact email, and selected
  screenshots into toolkit.

## Cloud V2 API

Primary mobile/toolkit route:

```text
POST /api/client/incidents
POST /api/client/incidents/:incidentId/artifacts
POST /api/client/incidents/:incidentId/complete
POST /api/client/feedback
```

Compatibility log-ingress adapter for current glasses upload code:

```text
POST /api/incidents/:incidentId/logs
```

The adapter is only for glasses log upload after mobile has created a Cloud V2
incident and relayed the id/base URL. It is not the primary mobile incident API,
and it does not replace or delete Cloud V1 endpoints.

### Create Incident

```http
POST /api/client/incidents
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "trigger": {
    "type": "manual",
    "surface": "feedback_screen",
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
  "incidentId": "inc_...",
  "status": "collecting",
  "created": true
}
```

`created: false` means server-side dedupe found a recent open incident with the
same user and `dedupeKey`.

### Add Logs

```http
POST /api/client/incidents/:incidentId/artifacts
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
POST /api/client/incidents/:incidentId/artifacts
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

### Complete Incident Collection

```http
POST /api/client/incidents/:incidentId/complete
Authorization: Bearer <core access token>
```

Response:

```json
{
  "status": "ready"
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

### Non-Incident Feedback

Feature requests and general feedback use a separate collection and route:

```http
POST /api/client/feedback
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "feedback": {
    "type": "feature",
    "message": "..."
  },
  "phoneState": {}
}
```

Response:

```json
{
  "success": true
}
```

## Data Model

`incidents`:

- `incidentId`
- `mentraUserId`
- `trigger`
- `report`
- `context`
- `dedupeKey`
- `artifacts`
- `status`: `collecting`, `ready`, or `closed`

`feedback`:

- `feedbackId`
- `mentraUserId`
- `feedback`
- `phoneState`

## Why This Shape

- `trigger` answers why this case exists.
- `report` answers what was observed.
- `context` answers what the smartglasses OS/runtime looked like.
- `artifacts` make evidence extensible without adding a new route for every
  future evidence type.
- `userSeverity` and `systemPriority` avoid mixing subjective user pain with
  automatic incident importance.
- `created` avoids a vague success boolean and makes dedupe explicit.

## Implementation Anchors

- `cloud-v2/packages/core/src/api/client/incidents.api.ts`
- `cloud-v2/packages/core/src/services/incident.service.ts`
- `cloud-v2/packages/core/src/models/incident.model.ts`
- `cloud-v2/packages/core/src/services/feedback.service.ts`
- `cloud-v2/packages/cloud-client/src/modules/core/incidents.ts`
- `cloud-v2/packages/cloud-client/src/modules/core/feedback.ts`
- `mobile/modules/island/src/facades/incidents.ts`
- `mobile/src/services/bugReport/bugReportIncident.ts`
- `mobile/src/services/bugReport/automaticBugReport.ts`
- `mobile/src/app/miniapps/settings/feedback.tsx`
