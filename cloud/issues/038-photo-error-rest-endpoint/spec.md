# Spec: Photo Error REST Endpoint

## Overview

**What this doc covers:** Adding a REST endpoint (`POST /api/client/photo/response`) so the phone can report photo errors (and successes) to the cloud over HTTP instead of WebSocket.

**Why this doc exists:** When a photo request fails on the phone (camera error, BLE timeout, upload failure), the error currently needs to travel back over the glasses WebSocket. But the whole point of error reporting is that things are going wrong — the WebSocket might be the thing that's flaky. REST is fire-and-forget reliable. The client team lead also prefers REST for this.

**What you need to know first:** The original WebSocket-based spec is in `cloud/docs/photo-error-reporting.md`. This spec supersedes the transport mechanism (WS → REST) but keeps the same payload shape and error codes.

**Who should read this:** Cloud engineers implementing the endpoint, client/mobile engineers calling it.

## The Problem in 30 Seconds

App requests a photo → cloud tells glasses → glasses/phone try to capture/transfer/upload → something fails → phone swallows the error silently → SDK hangs for 30s then times out. We need the phone to POST the error back immediately over REST so the cloud can reject the pending photo promise and notify the requesting app.

## Spec

### Endpoint

```
POST /api/client/photo/response
Authorization: Bearer <token>
Content-Type: application/json
```

Middleware: `clientAuth` → `requireUserSession` (same as device-state, notifications, etc.)

### Request Body — Error Case

```json
{
  "requestId": "uuid-from-original-take_photo",
  "success": false,
  "errorCode": "PHONE_UPLOAD_FAILED",
  "errorMessage": "Upload returned HTTP 502"
}
```

### Request Body — Success Case

```json
{
  "requestId": "uuid-from-original-take_photo",
  "success": true,
  "photoUrl": "https://...",
  "savedToGallery": true
}
```

### Error Codes

From existing `PhotoErrorCode` enum in `sdk/src/types/messages/glasses-to-cloud.ts`. No new codes needed.

| Code                    | When                                                  |
| ----------------------- | ----------------------------------------------------- |
| `CAMERA_INIT_FAILED`    | Camera couldn't initialize                            |
| `CAMERA_CAPTURE_FAILED` | Capture failed (glasses reported error)               |
| `CAMERA_BUSY`           | Another capture in progress                           |
| `CAMERA_TIMEOUT`        | Glasses didn't respond in time                        |
| `BLE_TRANSFER_FAILED`   | BLE photo transfer failed                             |
| `BLE_TRANSFER_TIMEOUT`  | BLE transfer timed out                                |
| `PHONE_UPLOAD_FAILED`   | Phone got the photo but HTTP upload to webhook failed |
| `PHONE_TIMEOUT`         | Phone-side timeout waiting for glasses                |
| `COMPRESSION_FAILED`    | Image compression failed                              |
| `UNKNOWN_ERROR`         | Catch-all                                             |

### Response

**200 — processed:**

```json
{
  "success": true,
  "message": "Photo response processed",
  "timestamp": "2026-02-17T..."
}
```

**400 — missing requestId:**

```json
{
  "success": false,
  "message": "requestId is required",
  "timestamp": "2026-02-17T..."
}
```

**503 — no active session** (from `requireUserSession` middleware, already handled)

### Cloud-Side Processing

The handler calls `userSession.photoManager.handlePhotoResponse(body)` — the exact same method that currently handles WebSocket photo responses from glasses. PhotoManager already normalizes the flat `{errorCode, errorMessage}` format:

```
PhotoManager.handlePhotoResponse()
  → normalizes {errorCode, errorMessage} into PhotoResponse.error shape
  → looks up pendingPhotoRequests by requestId
  → if success: sends photo result to the requesting app
  → if error: sends photo error to the requesting app
```

Zero changes needed in PhotoManager. It already handles both formats.

### Data Flow

```
Before (WebSocket):
  Phone → glasses WS → bun-websocket → glasses-message-handler → PhotoManager

After (REST):
  Phone → POST /api/client/photo/response → photo.api.ts → PhotoManager
```

Same destination, more reliable transport.

### Changes Summary

| File                               | Change                                      |
| ---------------------------------- | ------------------------------------------- |
| `src/api/hono/client/photo.api.ts` | **New file** — endpoint handler (~50 lines) |
| `src/api/hono/client/index.ts`     | Add 1 export line                           |
| `src/hono-app.ts`                  | Add 1 route mount line                      |
| `src/api/index.ts`                 | Add 1 Express mount line (compat)           |

### What the Client Sends (Kotlin)

Instead of `Bridge.sendWSText(...)`, the client makes an HTTP POST:

```kotlin
@JvmStatic
fun sendPhotoResponse(requestId: String, success: Boolean,
                      photoUrl: String? = null, savedToGallery: Boolean? = null,
                      errorCode: String? = null, errorMessage: String? = null) {
    val body = JSONObject().apply {
        put("requestId", requestId)
        put("success", success)
        if (success) {
            photoUrl?.let { put("photoUrl", it) }
            savedToGallery?.let { put("savedToGallery", it) }
        } else {
            errorCode?.let { put("errorCode", it) }
            errorMessage?.let { put("errorMessage", it) }
        }
    }
    // Use existing REST client that already handles auth headers
    cloudApi.post("/api/client/photo/response", body)
}
```

Call from the same 4 error paths listed in the original spec:

1. Glasses report failure (`processJsonMessage` case `"photo_response"` when `success == false`)
2. BLE transfer timeout (`handleTransferTimeout`)
3. BLE transfer failed (`handleTransferFailed`)
4. Phone upload failed (`processAndUploadBlePhoto` → `onError`)

## Decision Log

| Decision                                   | Alternatives considered                    | Why we chose this                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST over WebSocket                        | WebSocket (original spec)                  | The whole point is error reporting when things go wrong — WS might be the broken thing. REST is independent and reliable. Also follows the migration pattern: device state, notifications, calendar, location all moved from WS to REST. |
| Reuse `PhotoManager.handlePhotoResponse()` | New handler method                         | PhotoManager already normalizes both the flat `{errorCode, errorMessage}` shape and the nested `{error: {code, message}}` shape. No reason to duplicate.                                                                                 |
| Single endpoint for both success and error | Separate `/error` and `/success` endpoints | The phone already knows the full response shape. One endpoint, one code path. PhotoManager handles both cases.                                                                                                                           |
| `POST /api/client/photo/response`          | `/api/client/photo/error`                  | Handles both success and error. Matches the existing `photo_response` message type name.                                                                                                                                                 |
