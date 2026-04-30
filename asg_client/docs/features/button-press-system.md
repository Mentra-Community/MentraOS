# Button press system

The hardware camera button on Mentra Live is the only physical control with rich behavior — it triggers photos, starts/stops videos, and can be forwarded to apps. This doc covers how those events flow from the BES microcontroller to apps and to local capture, including the **gallery-mode** gate that decides whether to capture locally.

Source: `service/core/handlers/K900CommandHandler.java` (`handleConfigurableButtonPress`, `handlePhotoCapture`).

## Hardware to software path

1. **Physical press** — user presses the camera button.
2. **MCU detection** — the BES MCU debounces and classifies the press.
3. **UART command** — MCU sends a K900 protocol packet:
   - `cs_pho` — short press
   - `cs_vdo` — long press
   - `hs_ntfy` with `msg: "button click"` / `"button long click"` — newer firmware format
4. **`K900CommandHandler` dispatches** to `handleCameraButtonShortPress()` or `handleCameraButtonLongPress()`, which both call `handleConfigurableButtonPress(isLongPress)`.
5. **Universal forwarding** — *every* press is forwarded to the phone as a `button_press` event, regardless of any local-capture decision.
6. **Local capture decision** — runs through the gallery-mode gate (below), then takes the appropriate action.

## Universal forwarding to the phone

Every button press emits the following over BLE, before any local-capture logic:

```json
{
  "type": "button_press",
  "buttonId": "camera",
  "pressType": "short",
  "timestamp": 1708963201234
}
```

`pressType` is `"short"` or `"long"`. Apps subscribed via the phone get the event whether or not local capture happens.

## Local capture and gallery mode

Whether the button *also* captures a photo/video locally is governed by a single boolean: `AsgSettings.isSaveInGalleryMode()`. The phone toggles this via the [`save_in_gallery_mode`](../ASG_CLIENT_API.md#save_in_gallery_mode) command — typically when the user enters or leaves the gallery view in the phone app.

### Decision rules

```
isSaveInGalleryMode  isConnected       Local capture?
       true               *                 yes
       false              true              no — phone app handles it
       false              false             yes — fallback so disconnected glasses still capture
```

In words:
- **Gallery mode active** → always capture locally.
- **Gallery mode inactive but glasses connected to phone** → skip local capture (the phone routes the press to apps).
- **Gallery mode inactive and glasses disconnected** → still capture locally so a press isn't lost.

### Persistence

`saveInGalleryMode` is **persisted in SharedPreferences** under the key `save_in_gallery_mode` (`AsgSettings.java:22, 215, 229`). It defaults to `true` on first read. The default ensures button presses still capture before the phone has a chance to set the flag explicitly.

## Short press: photo or stop video

If a video is currently recording, a short press **stops the recording**. Otherwise it **takes a photo**:

```java
if (captureService.isRecordingVideo()) {
    captureService.stopVideoRecording();
} else {
    String photoSize = serviceManager.getAsgSettings().getButtonPhotoSize();
    captureService.takePhotoLocally(photoSize, ledEnabled, true /* sound */);
}
```

Settings consulted:
- `getButtonPhotoSize()` — `small` / `medium` / `large`. Set via [`button_photo_setting`](../ASG_CLIENT_API.md#button_photo_setting).
- `getButtonCameraLedEnabled()` — privacy LED on/off during capture. Set via [`button_camera_led`](../ASG_CLIENT_API.md#button_camera_led).

## Long press: video record / stop

If a video is recording, a long press **stops it**. Otherwise it **starts video recording** with persisted settings, after a battery check:

```java
if (captureService.isRecordingVideo()) {
    captureService.stopVideoRecording();
} else {
    if (batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
        captureService.playBatteryLowSound();
        return;
    }
    VideoSettings videoSettings = serviceManager.getAsgSettings().getButtonVideoSettings();
    int maxRecordingTimeMinutes = serviceManager.getAsgSettings().getButtonMaxRecordingTimeMinutes();
    captureService.startVideoRecording(videoSettings, ledEnabled, maxRecordingTimeMinutes, batteryLevel);
}
```

Settings consulted:
- `getButtonVideoSettings()` — width × height × fps. Set via [`button_video_recording_setting`](../ASG_CLIENT_API.md#button_video_recording_setting).
- `getButtonMaxRecordingTimeMinutes()` — auto-stop after N minutes. Set via [`button_max_recording_time`](../ASG_CLIENT_API.md#button_max_recording_time).

## Other buttons / events from the MCU

While the camera button is the main user-facing control, the same K900 dispatcher handles:

- **Touch / swipe** on the temple — `sr_swst`, `sr_tpevt`, `sr_fbvol` → forwarded to phone as `switch_status`, `touch_event`, `swipe_volume_status`.
- **Power-button short press** — `sr_keyevt` (button=0, type=0). Triggers an audio battery-level announcement (`AudioAssets.getBatteryLevelAsset(level)`).
- **Power-button hold (graceful shutdown)** — `cs_shut`. ASG client acks with `sr_shut`, finalizes any active video, then calls `SysControl.shut()` to avoid corrupted recordings.

These don't go through the gallery-mode gate — they have their own per-event handlers.

## Configuration via the phone app

The phone app sets button-related settings via the [API commands](../ASG_CLIENT_API.md#settings):

- `save_in_gallery_mode` — gallery-mode flag (the gate above)
- `button_photo_setting` — short-press photo resolution
- `button_video_recording_setting` — long-press video resolution + fps
- `button_max_recording_time` — max long-press recording duration
- `button_camera_led` — privacy LED enable

## Logcat tags

| Tag | What |
|-----|------|
| `K900CommandHandler` | Press detection and capture decision |
| `MediaCaptureService` (`PhotoTest`, `MediaCapture`) | Capture pipeline |
| `AsgSettings` | Settings persistence |

## Troubleshooting

- **Press doesn't capture locally** — check `📸 Photo capture decision` log line in `K900CommandHandler` for `Gallery Mode` and `Connection State`. If gallery mode is INACTIVE and connection state is CONNECTED, that's expected — the phone will route the press to apps but won't capture locally. Toggle gallery mode on the phone or disconnect to verify.
- **Press doesn't reach apps** — verify a `button_press` JSON is being sent over BLE. If not, check that the `cs_pho` / `cs_vdo` / `hs_ntfy` packet is arriving at all (TAG: `K900CommandHandler`, `📦 Received K900 command`).
- **Long press doesn't start video** — check battery level; recording is rejected below `BatteryConstants.MIN_BATTERY_LEVEL` (10%) with an audio cue.
- **Recording auto-stops too soon** — check `button_max_recording_time` setting; the default is 10 minutes.
