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

## Default right-eye status patterns

The RGB ring is the internal indicator visible near the right eye. It is not the
front-facing MTK recording/privacy LED. The patterns below describe the defaults
in BES firmware `17.26.07.22`.

Interpret the complete pattern rather than the color alone. For example, red can
mean that charging started, Bluetooth audio disconnected, an operation failed,
the battery is critically low, or the glasses are shutting down.

| Event | RGB ring pattern | Notes |
| --- | --- | --- |
| Normal power-on | Green fade, then solid green | Remains green while BES waits for the MTK Android side to respond. |
| MTK Android ready | Three green flashes | Each flash is approximately 200 ms, with a 100 ms gap. |
| Bluetooth audio/AVRCP connected | Blue for approximately 3 seconds | This reports the classic Bluetooth audio profile, not the Mentra App BLE session. |
| Bluetooth audio/AVRCP disconnected | Two quick red flashes | Approximately 100 ms on and 100 ms off per flash. |
| Touch gesture | Brief green flash | Approximately 80 ms; suppressed while MTK owns the ring. |
| Wear-state change | Green for approximately 1 second | Used for both wear-on and wear-off; suppressed while MTK owns the ring. |
| Recording or continuous-photo progress | Brief blue flash | Approximately 80 ms; suppressed while MTK owns the ring. |
| Operation failed or MTK unavailable | Brief red flash | Approximately 100 ms; suppressed while MTK owns the ring. |
| Charger connected while the glasses are already on | Five quick red flashes | Forced by BES even when MTK has claimed LED authority. |
| Charger disconnected at 0–25% | Three quick orange flashes | Forced by BES. |
| Charger disconnected at 26–65% | Three quick yellow flashes | Forced by BES. |
| Charger disconnected above 65% | Three quick green flashes | Forced by BES. |
| Battery at 4–10% | Brief orange flash every 2 minutes | Suppressed while MTK owns the ring. |
| Critically low battery | Five red flashes, then shutdown | Also used when starting below 20% and during automatic shutdown at 3% or lower. |
| Normal shutdown | Red fade | Accompanies the power-off sound. |
| Internal voice/VAD firmware update | Alternating green and blue | A failed update shows red for approximately 5 seconds. |

### Charging in the case

Current firmware does **not** show a continuous green "charging" or "fully
charged" indicator:

- If the glasses are already powered on when charging begins, BES shows five
  quick red flashes.
- If inserting powered-off glasses into the case causes a charge-only boot, BES
  skips the normal green boot indicator and the charger-connected red flashes.
  The ring normally remains off while charging.
- Reaching full charge does not turn the ring green.

The firmware contains an unused charging timer that would pulse red while
charging and show solid green near full charge. Nothing starts that timer, so it
is not part of the current user-visible behavior.

### Interaction with MentraOS control

These are firmware defaults, not guaranteed meanings for every light a user
sees. `asg_client` claims the ring when the MTK-to-BES UART connection becomes
ready and claims it again after the phone-ready handshake. While MTK owns the
ring, BES suppresses most non-forced status patterns. Charger connection and
disconnection patterns are explicitly forced and can still appear.

MentraOS also uses the ring for camera and streaming feedback, commonly as a
white flash or solid white light, and Mentra miniapps can request arbitrary
supported colors and patterns. A sustained color should therefore be correlated
with the active camera, stream, or miniapp rather than treated as a universal
device status.

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

| Command               | Purpose                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `rgb_led_control_on`  | Generic on/blink. Pick `led`, `ontime`, `offtime`, `count`, optional `brightness`.                      |
| `rgb_led_control_off` | Turn the ring off.                                                                                      |
| `rgb_led_photo_flash` | White flash for photo capture (default 5 s).                                                            |
| `rgb_led_video_solid` | Solid white for video recording (30 min internal duration; turned off explicitly when recording stops). |

Each command responds with `<command>_response` on success or `rgb_led_control_error` on failure / unsupported hardware.

## Recording-LED behavior (orchestration of both systems)

`MediaCaptureService` and the streaming services drive both LEDs together so the user gets a consistent privacy indicator:

| Event                     | Local MTK LED               | RGB ring                              |
| ------------------------- | --------------------------- | ------------------------------------- |
| Photo capture (flash on)  | brief flash                 | white flash via `rgb_led_photo_flash` |
| Video recording start     | solid on                    | white solid via `rgb_led_video_solid` |
| Video recording stop      | off                         | off via `rgb_led_control_off`         |
| Stream start              | solid on                    | (handled by stream service)           |
| Stream stop               | off                         | off                                   |
| Buffer recording active   | blinking (1 s on / 2 s off) | (BES default)                         |
| Buffer recording stopped  | off                         | (BES default)                         |
| Recording error           | off                         | off                                   |

The local MTK capture LED is always enabled for photo, video, and stream capture.

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

| Tag                    | Component                            |
| ---------------------- | ------------------------------------ |
| `K900LedController`    | Local MTK LED                        |
| `K900RgbLedController` | RGB ring driver                      |
| `RgbLedCommandHandler` | Phone-facing RGB LED command handler |
| `K900CommandHandler`   | RGB authority claim/release          |
| `MediaCaptureService`  | Recording-LED orchestration          |
