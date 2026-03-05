# Photo Error Reporting Spec

## Problem

When a photo request fails (camera error, BLE timeout, upload failure), the phone silently swallows the error. The SDK hangs for 30s then times out. We need the phone to send errors back immediately.

## What to send

Send a `photo_response` with `success: false` over the existing WebSocket to cloud. The cloud already parses this format — zero cloud changes needed for ingestion.

```json
{
  "type": "photo_response",
  "requestId": "<original requestId from take_photo>",
  "success": false,
  "errorCode": "<see codes below>",
  "errorMessage": "<human readable string>",
  "timestamp": 1234567890
}
```

## Error codes

Use the string that matches the failure:

| Code                    | When to use                                           |
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

Full enum: `sdk/src/types/messages/glasses-to-cloud.ts` → `PhotoErrorCode`

## Where to send from (MentraLive.java)

**1. Glasses report failure** — `processJsonMessage` case `"photo_response"` when `success == false`

**2. BLE transfer timeout** — `handleTransferTimeout` when cleaning up a `BlePhotoTransfer`

**3. BLE transfer failed** — `handleTransferFailed` when cleaning up a `BlePhotoTransfer`

**4. Phone upload failed** — `processAndUploadBlePhoto` → `onError` callback (currently commented out)

## How to send (Bridge.kt)

Add `sendPhotoError` next to existing `sendPhotoResponse`:

```kotlin
@JvmStatic
fun sendPhotoError(requestId: String, errorCode: String, errorMessage: String) {
    val event = HashMap<String, Any>()
    event["type"] = "photo_response"
    event["requestId"] = requestId
    event["success"] = false
    event["errorCode"] = errorCode
    event["errorMessage"] = errorMessage
    event["timestamp"] = System.currentTimeMillis()
    sendWSText(JSONObject(event as Map<*, *>).toString())
}
```

Then call `Bridge.sendPhotoError(requestId, "ERROR_CODE", "message")` from the 4 places above.

## Our side (cloud/SDK)

We'll update the SDK to reject the pending photo Promise immediately when it receives this error instead of waiting for the 30s timeout. No action needed from client team for that.
