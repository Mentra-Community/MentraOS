# 019 - Incident Reporting Migration

**Status:** Implemented / partial

## Problem

The mobile incident reporting path is still coupled to Cloud V1 semantics and
partly lives outside the island/toolkit boundary.

Current mobile flow:

1. Host mobile UI builds bug-report form data.
2. Host mobile helpers build a phone-state snapshot and collect recent logs.
3. Host mobile calls incident REST endpoints through `RestComms`.
4. Host mobile uploads phone logs and screenshot attachments.
5. Host mobile notifies the glasses with the returned incident id.

The target Cloud V2 shape is different:

- Cloud V1 under `cloud/` remains untouched for now.
- Cloud V2 adds its own incident API under `cloud-v2/`.
- The REST requester lives in `cloud-v2/packages/cloud-client/`.
- The smartglasses OS/runtime incident machinery moves into
  `@mentra/island` / toolkit.
- OEM apps keep ownership of UI and presentation details.

This issue is the migration plan for that split.

## Goals

1. Add Cloud V2 incident creation, log upload, attachment upload, and feedback
   endpoints.
2. Expose those endpoints through `@mentra/cloud-client`.
3. Make `toolkit.incidents` the mobile-side owner of the incident flow.
4. Reduce host/OEM code to UI, prompt, and trigger-specific data assembly.
5. Preserve Cloud V1 endpoints and existing released clients while Cloud V2
   rolls out.

## Non-Goals

- Do not delete or rewrite Cloud V1 incident APIs.
- Do not change already released glasses firmware base URLs.
- Do not move OEM-specific forms, wording, alerts, or screenshot-picker UX into
  toolkit.
- Do not build Console/admin incident views in this issue, beyond keeping the
  Cloud V2 data model compatible with that future work.

## Current Code Anchors

Mobile and toolkit:

- `mobile/src/services/bugReport/bugReportIncident.ts`
  - Builds sanitized phone state.
  - Builds bug-report feedback metadata.
  - Calls incident REST methods.
  - Uploads logs/screenshots.
  - Notifies glasses.
- `mobile/modules/island/src/facades/incidents.ts`
  - Already exposes `toolkit.incidents.file(...)` and lower-level primitives.
  - Still delegates to island `RestComms`.
- `mobile/modules/island/src/services/RestComms.ts`
  - Current v1-style incident methods:
    - `createIncident`
    - `uploadIncidentLogs`
    - `uploadIncidentAttachments`
    - `sendFeedback`

Cloud V1 reference:

- `cloud/packages/cloud/src/api/hono/client/incident-logs.api.ts`
  - `POST /api/incidents`
  - `POST /api/incidents/:incidentId/logs`
  - `POST /api/incidents/:incidentId/attachments`
- `cloud/packages/cloud/src/services/incidents/incident-processor.service.ts`
  - Background processing pattern and downstream notifications.

Cloud V2 patterns to follow:

- `cloud-v2/packages/core/src/api/client/auth.api.ts`
  - Device-called core API route style.
- `cloud-v2/packages/core/src/api/middleware/user-auth.middleware.ts`
  - Authenticated user middleware.
- `cloud-v2/packages/cloud-client/src/modules/core/core.ts`
  - Device-facing core REST module.
- `cloud-v2/packages/cloud-client/src/http.ts`
  - Shared JSON HTTP helper.

## Placement Decision

Incident records are durable user data, so Cloud V2 incidents should live in
`cloud-v2/packages/core`, not `cloud-v2/packages/runtime`.

Rationale:

- Core already owns Mongo and user identity.
- Runtime is session-oriented and currently uses Redis/object storage patterns
  for live flows such as audio, camera, maps, and TTS.
- Incidents need durable records that future Console/admin tools can query.

Runtime may later contribute cloud-runtime logs to an incident, but runtime is
not the owner of incident persistence.

## Target Cloud V2 API

Mount these device-called routes in Cloud V2 core:

```text
POST /api/incidents
POST /api/incidents/:incidentId/logs
POST /api/incidents/:incidentId/attachments
POST /api/client/feedback
```

The `/api/incidents` path is a Cloud V2 compatibility mount for the existing
mobile incident route shape. It does not mean deleting or modifying the Cloud V1
`cloud/` endpoint.

### Create Incident

```http
POST /api/incidents
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "feedback": {
    "type": "bug",
    "expectedBehavior": "...",
    "actualBehavior": "...",
    "severityRating": 4,
    "submissionMode": "USER_INITIATED",
    "triggerArea": "feedback_screen",
    "triggerReason": "manual_bug_report",
    "systemInfo": {},
    "glassesInfo": {}
  },
  "phoneState": {}
}
```

Unlike Cloud V1, Cloud V2 does not accept the loose legacy incident shape.
`feedback.type`, `expectedBehavior`, `actualBehavior`, `severityRating`,
`submissionMode`, `triggerArea`, `triggerReason`, `systemInfo`, and
`phoneState` are required for incident creation. Optional fields remain only for
truly variable data such as `contactEmail`, `glassesInfo`, and source miniapp
metadata.

Response:

```json
{
  "success": true,
  "incidentId": "inc_..."
}
```

### Upload Logs

```http
POST /api/incidents/:incidentId/logs
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "source": "phone",
  "logs": [
    {
      "timestamp": 1710000000000,
      "level": "info",
      "message": "...",
      "source": "mobile"
    }
  ]
}
```

Response:

```json
{
  "success": true
}
```

### Upload Attachments

```http
POST /api/incidents/:incidentId/attachments
Authorization: Bearer <core access token>
Content-Type: multipart/form-data
```

Request:

- `files`: one or more image files.

Response:

```json
{
  "uploaded": 1,
  "errors": 0
}
```

### Send Feedback

```http
POST /api/client/feedback
Authorization: Bearer <core access token>
Content-Type: application/json
```

Request:

```json
{
  "feedback": {
    "type": "feature_request",
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

## Cloud V2 Core Implementation

Add:

- `cloud-v2/packages/core/src/models/incident.model.ts`
- `cloud-v2/packages/core/src/services/incident.service.ts`
- `cloud-v2/packages/core/src/api/client/incidents.api.ts`
- route mount in `cloud-v2/packages/core/src/api/app.ts`

### Incident Model

Minimum Mongo document shape:

```ts
interface IncidentDoc {
  incidentId: string
  mentraUserId: string
  feedback: Record<string, unknown>
  phoneState: Record<string, unknown>
  phoneLogs: IncidentLogEntry[]
  attachments: IncidentAttachment[]
  status: "open" | "processing" | "closed"
  createdAt: Date
  updatedAt: Date
}
```

Log entry:

```ts
interface IncidentLogEntry {
  timestamp: number
  level: string
  message: string
  source?: string
}
```

Attachment metadata:

```ts
interface IncidentAttachment {
  filename: string
  contentType: string
  sizeBytes: number
  storageKey?: string
  uploadedAt: Date
}
```

### Service Responsibilities

`incident.service.ts` should own:

- Create incident ids.
- Store the authenticated `mentraUserId`.
- Validate that log/attachment uploads belong to the authenticated user.
- Append phone logs.
- Store attachment metadata.
- Leave hooks for future cloud-log collection and notification processing.

### Attachment Storage

First choice: reuse a Cloud V2 core storage abstraction if it exists by the time
this is implemented.

If not, keep the API contract and start with a narrow local implementation:

- Store attachment metadata in Mongo.
- Store bytes in a configured object store or local dev path through a small
  incident-specific storage helper.
- Keep storage helper private to incidents until the core storage-service spec
  is ready.

Do not push attachment upload logic into runtime just because runtime already
has camera blob storage. Incident attachments are core user records.

## Cloud-Client Implementation

Add:

- `cloud-v2/packages/cloud-client/src/modules/core/incidents.ts`
- wire it into `cloud-v2/packages/cloud-client/src/modules/core/core.ts`
- extend `cloud-v2/packages/cloud-client/src/http.ts` with multipart support

Target client surface:

```ts
cloud.core?.incidents.create(feedback, phoneState)
cloud.core?.incidents.uploadLogs(incidentId, logs)
cloud.core?.incidents.uploadAttachments(incidentId, images)
cloud.core?.incidents.sendFeedback(feedback, phoneState)
```

Suggested types:

```ts
export interface CreateIncidentResult {
  success: boolean
  incidentId: string
}

export interface IncidentBugFeedback {
  type: "bug"
  expectedBehavior: string
  actualBehavior: string
  severityRating: number
  submissionMode: "USER_INITIATED" | "AUTOMATIC"
  triggerArea: string
  triggerReason: string
  systemInfo: Record<string, unknown>
  contactEmail?: string
  glassesInfo?: Record<string, unknown>
  sourceAppletPackageName?: string
  sourceAppletName?: string
}

export interface IncidentLogEntry {
  timestamp: number
  level: string
  message: string
  source?: string
}

export interface IncidentAttachmentInput {
  uri: string
  fileName?: string | null
  mimeType?: string | null
}
```

### Multipart HTTP Helper

`HttpClient` currently JSON-serializes request bodies. Attachments need one of:

```ts
postForm<T>(path: string, form: FormData, opts?: ReqOpts): Promise<T>
```

or an incidents-only helper that still reuses token resolution and non-2xx error
mapping.

Prefer `postForm` because camera, miniapp uploads, or future feedback artifacts
may need the same behavior.

## Toolkit / Island Implementation

Update:

- `mobile/modules/island/src/facades/incidents.ts`
- `mobile/modules/island/src/services/CloudClientService.ts`
- incident-related island tests

`toolkit.incidents` should own the OS/runtime mechanics:

- Build and redact runtime state where the data is island-owned.
- Get recent phone/toolkit logs through an island-owned log source or injected
  host log provider.
- Create incidents through `cloudClientService.core.incidents`.
- Upload logs.
- Notify connected glasses with the incident id and the active API base URL.
- Upload attachments.
- Provide automatic incident helpers with dedupe and categorization support.

Target toolkit API:

```ts
toolkit.incidents.file(input)
toolkit.incidents.fileAutomatic(input)
toolkit.incidents.sendFeedback(input)
```

### `file`

Manual user-submitted bug reports:

```ts
interface FileIncidentInput {
  feedbackData: IncidentBugFeedback
  phoneState: Record<string, unknown>
  logs?: IncidentLogEntry[]
  screenshots?: IncidentAttachmentInput[]
}
```

The host UI passes the required typed bug feedback, the gathered phone-state
snapshot, screenshots, and optional host-native diagnostic facts. Toolkit
handles create/upload/notify sequencing.

### `fileAutomatic`

Runtime or product-triggered incidents:

```ts
interface FileAutomaticIncidentInput {
  categorization: {
    submissionMode: "AUTOMATIC"
    triggerArea: string
    triggerReason: string
    sourceAppletPackageName?: string
    sourceAppletName?: string
  }
  expectedBehavior: string
  actualBehavior: string
  severityRating: number
  dedupeKey?: string
  dedupeWindowMs?: number
}
```

Toolkit owns dedupe because duplicate suppression is runtime behavior, not UI.

### `sendFeedback`

Non-bug feedback:

```ts
interface SendFeedbackInput {
  feedback: string | Record<string, unknown>
  phoneState?: Record<string, unknown>
}
```

## Host / OEM Boundary

Host/OEM code remains responsible for:

- Feedback screen layout.
- User-facing copy.
- Form fields and severity labels.
- Screenshot picker UX.
- Confirmation alerts and toasts.
- OEM-specific prompts.
- Optional native facts that only the host app can gather.

Host/OEM code should not own:

- Which Cloud V2 endpoint to call.
- Core token attachment.
- Incident REST sequencing.
- Phone/toolkit log upload.
- Glasses notification mechanics.
- Runtime automatic incident dedupe.

## Mobile Caller Migration

Thin host callers should call toolkit APIs instead of `RestComms`.

Update:

- `mobile/src/app/miniapps/settings/feedback.tsx`
  - Gather form data and screenshots.
  - Call `toolkit.incidents.file(...)` for bug reports.
  - Call `toolkit.incidents.sendFeedback(...)` for non-bug feedback.
- `mobile/src/services/bugReport/automaticBugReport.ts`
  - Become a compatibility wrapper around `toolkit.incidents.fileAutomatic(...)`,
    or move fully into island.
- `mobile/src/services/bugReport/miniappStartBugReport.ts`
  - Build trigger metadata and call `fileAutomatic`.
- `mobile/src/services/bugReport/galleryVideoPlaybackBugReport.ts`
  - Build trigger metadata and call `fileAutomatic`.
- `mobile/src/services/MantleManager.ts`
  - Keep trigger decision local if it is app-specific; call toolkit for filing.
- `mobile/src/services/mentraJsBootstrap.ts`
  - Same: trigger outside, filing inside toolkit.

After migration, `mobile/src/services/bugReport/bugReportIncident.ts` should be
either deleted or reduced to a host compatibility shim with no REST calls.

## Compatibility Strategy

Cloud V1 remains available:

- Do not delete `cloud/packages/cloud/src/api/hono/client/incident-logs.api.ts`.
- Do not change the Cloud V1 `/api/incidents` behavior.
- Do not change glasses-side assumptions for already released builds.

Cloud V2 adds:

- Its own `/api/incidents` mount in core.
- Cloud-client methods that point at Cloud V2 core.
- Toolkit code that uses cloud-client.

The active mobile app selects Cloud V2 through its cloud-client/core endpoint
configuration. Existing released clients that still point at Cloud V1 continue
using Cloud V1.

## Testing Plan

Cloud V2 core:

- Create incident requires auth.
- Create incident rejects incomplete legacy bug-report shapes.
- Create incident stores `mentraUserId`.
- Upload logs requires same authenticated user.
- Upload logs appends entries and preserves source.
- Attachment upload rejects invalid incident/user.
- Feedback endpoint accepts non-bug feedback.

Cloud-client:

- `cloud.core.incidents.create` posts to `/api/incidents`.
- `uploadLogs` posts to `/api/incidents/:id/logs`.
- `uploadAttachments` sends multipart form data with bearer auth.
- Non-2xx responses map to `HttpError`.

Toolkit/island:

- `toolkit.incidents.file` sequences create -> upload logs -> notify glasses ->
  upload attachments.
- Detached call still works:
  `const { file } = toolkit.incidents; await file(input)`.
- Glasses notification is a no-op when disconnected.
- Automatic dedupe suppresses duplicates in the configured window.

Mobile:

- Feedback UI calls toolkit, not `RestComms`.
- Automatic incident triggers call toolkit.
- Existing tests for miniapp-start and gallery-video incidents still pass.

Suggested commands:

```bash
cd cloud-v2 && bun test
cd mobile && bun compile
cd mobile && bun test -- automaticBugReport
git diff --check
```

## Rollout Plan

### PR 1: Add Cloud V2 incident backend and client

- Add core model/service/API.
- Add cloud-client incidents module.
- Add multipart HTTP support.
- Add tests.
- Do not touch host mobile callers yet.

### PR 2: Move mobile filing through toolkit

- Wire `CloudClientService` to expose core incidents.
- Update `toolkit.incidents`.
- Move host bug-report helpers to toolkit calls.
- Keep Cloud V1 `RestComms` incident methods temporarily.

### PR 3: Cleanup and hardening

- Remove unused mobile `RestComms` incident calls once no callers remain.
- Add admin/console retrieval if needed.
- Add runtime/cloud-log collection.
- Add quotas/rate limits if incidents become noisy.

## Open Questions

1. Should `fileAutomatic` live only in toolkit, or should host code keep small
   trigger-specific wrappers for readability?
2. Should incident attachments use a general Cloud V2 core storage service now,
   or an incident-private helper until `001-cloud-core/storage-service` is
   specced?
3. Should Cloud V2 incident ids preserve the v1 id shape or move to an explicit
   `inc_` prefix?
4. Should Cloud V2 immediately enqueue background processing, or should that
   wait until Console/admin retrieval lands?
5. Should `sendFeedback` be part of `toolkit.incidents`, or a separate
   `toolkit.feedback` facade later?
