# LED control

Mentra Live has **two distinct LED systems** that are easy to confuse. This doc covers both, then explains how the recording pipeline coordinates them.

## Two systems

### 1. Local MTK recording LED (single LED, on the device)

A single privacy LED on the glasses, controlled directly by the Android (MTK) SoC via the native `libxydev.so` library. Used to indicate that the camera is in use.

- Owned by: `K900LedController` (singleton)
- JNI surface: `com.dev.api.DevApi.setLedOn(boolean)`
- Selected at runtime via `K900HardwareManager.supportsRecordingLed()` / `setRecordingLedOn()`
- Convenience wrappers: `SysControl.setRecordingLedOn(context, on)`, `SysControl.setRecordingLedBlinking(context, blink)`, `SysControl.flashRecordingLed(context, durationMs)`
- Native libs ship in `app/src/main/jniLibs/{armeabi-v7a,arm64-v8a}/libxydev.so`

### 2. RGB LED ring (multi-color, on the BES chipset)

The colored LEDs visible on the glasses themselves. Controlled by the BES microcontroller, addressed from MTK by sending K900 protocol commands over UART.

- Owned by: `K900RgbLedController` (`hardware/K900RgbLedController.java`)
- K900 commands: `cs_ledon`, `cs_ledoff`, `cs_ledsetlevel`
- Public API entry point from the phone: [`rgb_led_control_on` / `rgb_led_control_off` / `rgb_led_photo_flash` / `rgb_led_video_solid`](../ASG_CLIENT_API.md#rgb-led-control)
- Available colors (LED index): `0=red`, `1=green`, `2=blue`, `3=orange`, `4=white`

## RGB LED control authority

By default, BES owns the RGB ring and uses it to indicate battery state, Bluetooth connection, and firmware-upgrade progress. For ASG client to drive the ring programmatically, MTK must **claim** authority from BES. When the app shuts down, it **releases** authority and BES resumes its default behavior.

The handoff command (sent over UART):

```json
{"C": "android_control_led", "V": 1, "B": "{\"on\":true}"}
```

`on: true` claims, `on: false` releases.

Lifecycle in `AsgClientService` and `PhoneReadyCommandHandler`:

- **Claim** — `phone_ready` is received, ~500 ms after `glasses_ready`. Also re-sent on Bluetooth reconnection.
- **Release** — `AsgClientService.onDestroy()`.

If the claim isn't sent, RGB LED commands appear to "succeed" at the API surface but BES ignores them in favor of its own LED logic.

## Wire format for `cs_ledon` / `cs_ledoff`

`K900RgbLedController.setLedOn(led, ontime, offtime, count, brightness)` produces:

```json
{
  "C": "cs_ledon",
  "V": 1,
  "B": "{\"led\":4,\"ontime\":500,\"offtime\":500,\"count\":3,\"brightness\":100}"
}
```

Off:

```json
{"C": "cs_ledoff", "V": 1, "B": "{}"}
```

`B` is a JSON-string-inside-JSON — that's the K900 protocol convention.

Bounds:
- `led` — 0 (red) … 4 (white)
- `ontime` / `offtime` — milliseconds, ≥ 0
- `count` — cycles, ≥ 0
- `brightness` — 0 … 255 (`DEFAULT_RGB_LED_BRIGHTNESS = 100`)

## Phone-facing commands

These commands are documented in detail in [ASG_CLIENT_API.md#rgb-led-control](../ASG_CLIENT_API.md#rgb-led-control). Quick reference:

| Command | Purpose |
|---------|---------|
| `rgb_led_control_on` | Generic on/blink. Pick `led`, `ontime`, `offtime`, `count`, optional `brightness`. |
| `rgb_led_control_off` | Turn the ring off. |
| `rgb_led_photo_flash` | White flash for photo capture (default 5 s). |
| `rgb_led_video_solid` | Solid white for video recording (30 min internal duration; turned off explicitly when recording stops). |

Each command responds with `<command>_response` on success or `rgb_led_control_error` on failure / unsupported hardware.

## Recording-LED behavior (orchestration of both systems)

`MediaCaptureService` and the streaming services drive both LEDs together so the user gets a consistent privacy indicator:

| Event | Local MTK LED | RGB ring |
|-------|---------------|----------|
| Photo capture (flash on) | brief flash | white flash via `rgb_led_photo_flash` |
| Photo capture (flash off) | nothing | nothing |
| Video recording start | solid on | white solid via `rgb_led_video_solid` |
| Video recording stop | off | off via `rgb_led_control_off` |
| Stream start | solid on | (handled by stream service) |
| Stream stop | off | off |
| Buffer recording active | blinking (1 s on / 2 s off) | (BES default) |
| Buffer recording stopped | off | (BES default) |
| Recording error | off | off |

Whether the local MTK LED actually fires for a given button-triggered capture is gated by the [`button_camera_led` setting](../ASG_CLIENT_API.md#button_camera_led).

## Direct manipulation (Java only — not generally needed)

```java
// Local MTK recording LED
SysControl.setRecordingLedOn(context, true);
SysControl.setRecordingLedBlinking(context, true);
SysControl.flashRecordingLed(context, 500);   // 500 ms flash

// Or directly:
K900LedController.getInstance().turnOn();
K900LedController.getInstance().startBlinking(500, 1000);   // custom on/off
K900LedController.getInstance().flash(1000);

// RGB LED (sends to BES; requires MTK to have claimed authority)
K900RgbLedController.getInstance().setLedOn(
    K900RgbLedController.RGB_LED_RED,
    /*ontime*/ 1000, /*offtime*/ 1000, /*count*/ 5,
    K900RgbLedController.DEFAULT_RGB_LED_BRIGHTNESS);
K900RgbLedController.getInstance().flashWhite(5000);
K900RgbLedController.getInstance().setSolidWhite(1_800_000); // 30 min
K900RgbLedController.getInstance().setLedOff();
```

In application code, prefer routing through the BLE command surface (so the phone-side state stays in sync) rather than calling these controllers directly.

## Failure modes

- **`libxydev.so` doesn't load** — `K900LedController` logs the error and becomes a no-op. The local MTK LED simply doesn't light. App keeps running.
- **MTK never claimed RGB authority** — RGB commands appear to succeed but the ring continues showing BES's defaults. Check that `phone_ready` was received and `🚨 Sending RGB LED authority command:` appears in logcat.
- **Hardware doesn't support RGB LEDs** — `RgbLedCommandHandler` returns an error response (`{"type": "rgb_led_control_error", "error": "RGB LED not supported on this device"}`) and short-circuits.

## Logcat tags

| Tag | Component |
|-----|-----------|
| `K900LedController` | Local MTK LED |
| `K900RgbLedController` | RGB ring driver |
| `RgbLedCommandHandler` | Phone-facing RGB LED command handler |
| `K900CommandHandler` | RGB authority claim/release |
| `MediaCaptureService` | Recording-LED orchestration |
