# LED control

Mentra Live has **two distinct on-glasses LED systems**, and the charging case
has a separate indicator of its own. This doc distinguishes all three, then
explains how the recording pipeline coordinates the two LEDs on the glasses.

## On-glasses LED systems

### 1. Local MTK recording LED (single LED, on the device)

A single privacy LED on the glasses, controlled directly by the Android (MTK) SoC via the native `libxydev.so` library. Used to indicate that the camera is in use.

- Owned by: `K900LedController` (singleton)
- JNI surface: `com.dev.api.DevApi.setLedOn(boolean)`
- Selected at runtime via `K900HardwareManager.supportsRecordingLed()` / `setRecordingLedOn()`
- Convenience wrappers: `SysControl.setRecordingLedOn(context, on)`, `SysControl.setRecordingLedBlinking(context, blink)`, `SysControl.flashRecordingLed(context, durationMs)`
- Native libs ship in `app/src/main/jniLibs/{armeabi-v7a,arm64-v8a}/libxydev.so`

### 2. RGB status LED (multi-color, on the BES chipset)

The internal multicolor status LED visible near the right eye. Controlled by the
BES microcontroller, addressed from MTK by sending K900 protocol commands over
UART.

- Owned by: `K900RgbLedController` (`hardware/K900RgbLedController.java`)
- K900 commands: `cs_ledon`, `cs_ledoff`, `cs_ledsetlevel`
- Public API entry point from the phone: [`rgb_led_control_on` / `rgb_led_control_off` / `rgb_led_photo_flash` / `rgb_led_video_solid`](../ASG_CLIENT_API.md#rgb-led-control)
- Available colors (LED index): `0=red`, `1=green`, `2=blue`, `3=orange`, `4=white`

## RGB LED control authority

At startup, BES owns the RGB status LED. Once the MTK-to-BES UART transport is
ready, ASG client **claims** authority so BES suppresses its ordinary
ownership-sensitive LED output. When the app shuts down, it **releases**
authority.

The handoff command (sent over UART):

```json
{"C": "android_control_led", "V": 1, "B": "{\"on\":true}"}
```

`on: true` claims, `on: false` releases.

Lifecycle in `AsgClientService` and `PhoneReadyCommandHandler`:

- **Claim** — immediately when the UART transport reports that it is connected.
  It is also re-sent approximately 500 ms after `phone_ready` is handled and on
  later transport reconnections.
- **Release** — `AsgClientService.onDestroy()`.

The authority flag is not a permission check around `cs_ledon` or `cs_ledoff`;
those commands drive the LED directly. Its purpose is to keep ordinary BES
status helpers from interfering with MTK output. Forced charger patterns and
direct BES firmware-update or shutdown output can still change the LED while
MTK owns it.

## Status patterns reachable in normal operation

The RGB status LED is the internal indicator visible near the right eye. It is
not the front-facing MTK recording/privacy LED. The patterns below are the
current user-visible paths after accounting for the normal BES-to-MTK ownership
handoff. The BES behavior was checked against firmware `17.26.07.22`.

Interpret the complete pattern rather than the color alone. For example, red can
mean that charging started, a BES firmware update failed, or the glasses are
shutting down.

| Event | RGB status LED pattern | Notes |
| --- | --- | --- |
| Normal power-on | Green fade, then solid green | Remains green while BES waits for the MTK Android side to respond. |
| First MTK UART contact | Three green flashes | BES shows this before processing the first MTK command. Each flash is approximately 200 ms, with a 100 ms gap; ASG client then claims LED authority. |
| Photo capture | White for approximately 2.2 seconds | Driven by `MediaCaptureService` for button and SDK photo paths. |
| Video recording | Solid white | The command has a 30-minute duration and is explicitly stopped on recording stop or error. |
| USB UVC streaming | Solid white | Uses the same 30-minute command and is explicitly stopped when UVC streaming stops. |
| Charger connected while the glasses are already on | Five quick red flashes | Forced by BES even when MTK has claimed LED authority. |
| Charger disconnected at 0–25% | Three quick orange flashes | Forced by BES. |
| Charger disconnected at 26–65% | Three quick yellow flashes | Forced by BES. |
| Charger disconnected above 65% | Three quick green flashes | Forced by BES. |
| BES firmware update in progress | Brief blue flash every 3 seconds | Each flash is approximately 100 ms. The update path writes the LED directly. |
| BES firmware update succeeded | Three quick green flashes | Approximately 100 ms on and 100 ms off per flash. |
| BES firmware update failed verification | Solid red | Written directly by the BES update path. |
| Normal shutdown | Red fade | Accompanies the power-off sound. |
| Mentra miniapp or Mentra App LED request | Requested color and timing | Red, green, blue, orange, and white are supported; this has no universal status meaning. |

### Glasses status LED while charging in the case

Current firmware does **not** show a continuous green "charging" or "fully
charged" indicator:

- If the glasses are already powered on when charging begins, BES shows five
  quick red flashes.
- If inserting powered-off glasses into the case causes a charge-only boot, BES
  skips the normal green boot indicator and the charger-connected red flashes.
  The status LED normally remains off while charging.
- Reaching full charge does not turn the status LED green.

## Charging case indicator

The charging case has its own external power indicator. It is separate from
both LEDs on Mentra Live and is not controlled by the BES-to-MTK authority
handoff described above.

**The charging case indicator always reports the battery level of the case
itself, not the battery level of the Mentra Live glasses.**

Newer charging cases use only orange and green for this indication:

| Charging case battery level | Indicator color |
| --- | --- |
| Below approximately 70% | Orange |
| Above approximately 70% | Green |

Opening the lid, inserting or removing the glasses, connecting or disconnecting
external power, or pressing the case button can trigger the case indicator. The
light may be steady, blinking, or breathing depending on the event and whether
power is flowing, but its orange/green battery meaning remains the same: it
reports the charging case, not the glasses.

### Interaction with MentraOS control

`asg_client` claims the status LED when the MTK-to-BES UART connection becomes
ready and claims it again after the phone-ready handshake. While MTK owns the
status LED, BES suppresses its ordinary ownership-sensitive patterns. Charger
transitions are explicitly forced, and BES firmware-update and shutdown paths
write the hardware directly, so those patterns can still appear.

MentraOS uses the status LED for photo, video-recording, and USB UVC feedback.
RTMP, SRT, and WHIP livestreaming currently drive only the separate MTK
recording/privacy LED and do not set the status LED. Mentra miniapps can request
any supported status LED color and timing, so an app-requested pattern has no
universal device meaning.

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
| `rgb_led_control_off` | Turn the status LED off.                                                                                |
| `rgb_led_photo_flash` | White flash for photo capture (default 5 s).                                                            |
| `rgb_led_video_solid` | Solid white for video recording (30 min internal duration; turned off explicitly when recording stops). |

Each command responds with `<command>_response` on success or `rgb_led_control_error` on failure / unsupported hardware.

## Camera LED behavior

The current camera paths use the two LED systems as follows:

The local privacy LED uses shared ownership across photo capture, video recording, UVC, and network
streaming. Releasing one camera user does not turn the LED off while another owner remains active.

| Event | Local MTK recording/privacy LED | RGB status LED |
| --- | --- | --- |
| Photo capture | On while any capture is pending; off when the last pending JPEG frame arrives | White for approximately 2.2 seconds |
| Video recording start | Solid on | Solid white, with a 30-minute command duration |
| Video recording stop or error | Off | Off |
| RTMP, SRT, or WHIP stream start | Solid on | Unchanged |
| RTMP, SRT, or WHIP stream stop | Off | Unchanged |
| USB UVC stream start | Solid on | Solid white, with a 30-minute command duration |
| USB UVC stream stop | Off | Off |

Current phone-command handlers require the local MTK capture LED for photo,
video, and network stream capture.

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
- **MTK never claimed RGB authority** — RGB commands can still drive the LED,
  but ownership-sensitive BES output is no longer suppressed and can interfere.
  Check for `🚨 Sending RGB LED authority command:` in logcat.
- **Hardware doesn't support RGB LEDs** — `RgbLedCommandHandler` returns an error response (`{"type": "rgb_led_control_error", "error": "RGB LED not supported on this device"}`) and short-circuits.

## Logcat tags

| Tag                    | Component                            |
| ---------------------- | ------------------------------------ |
| `K900LedController`    | Local MTK LED                        |
| `K900RgbLedController` | RGB status LED driver                |
| `RgbLedCommandHandler` | Phone-facing RGB LED command handler |
| `K900CommandHandler`   | RGB authority claim/release          |
| `MediaCaptureService`  | Recording-LED orchestration          |
