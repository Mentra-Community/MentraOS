# Mentra Live WHIP battery and thermal characterization

**Status:** Ongoing internal engineering characterization. These results are
observations from individual devices and test runs, not committed product
specifications.

## Results matrix

All completed tests start from a fully charged Mentra Live and end when the
production battery safeguard stops streaming below 15%. “Maximum stream time”
is cumulative confirmed video time, excluding intervals when the WHIP session
had audio but no valid video.

| Resolution | FPS | Bitrate | Maximum observed stream time from 100% battery | Stability | Peak CPU/internal heat |
| --- | ---: | --- | ---: | --- | ---: |
| 480p | 15 | TBD | Not tested | Not tested | TBD |
| 480p | 24 | TBD | Not tested | Not tested | TBD |
| 720p | 15 | 2.5 Mbps maximum; 1.66 Mbps observed average | 41:36* | 1 drop / 2 video segments — Camera2 `ERROR_CAMERA_DEVICE` | 73.1 °C |
| 720p | 24 | 2.5 Mbps maximum; 1.39 Mbps observed average | 33:43† | 1 drop / 2 stream segments — LAN loss and WHIP reconnect failure | 79.9 °C |
| 1080p | 15 | 3.5 Mbps maximum; 2.60 Mbps observed average | 36:19‡ | 2 drops / 3 video segments — LAN/ICE disconnects | 78.2 °C |
| 1080p | 24 | TBD | Not tested | Not tested | TBD |

\* Split by a camera failure and restart; not a proven continuous-call runtime.

† Split by a network failure and restart, with minor pretest battery use.

‡ Split by two LAN/ICE drops; used TCP ICE fallback and had pretest overhead.

### Stability definition

A **drop** is an unexpected loss of valid video that required a new WHIP
session. The intentional stop at the production battery cutoff is not counted
as a drop. Startup resolution ramping and temporary WebRTC resolution
adaptation are also not counted unless valid video stops.

### Result qualifications

#### 720p at 15 fps

- Confirmed video time was 31:31 before the camera failure plus 10:05 after
  restarting, for 41:36 total.
- Camera2 error 4 (`ERROR_CAMERA_DEVICE`) stopped video while audio continued.
- The invalid audio-only session was stopped after 1:57, followed by a
  0:54 restart gap. Total time without video was 2:52.
- Wall time from the first live publisher to the production 14% cutoff was
  44:28.
- Because the camera failure reduced power consumption during the interruption,
  41:36 is not yet a proven continuous-call runtime.

#### 720p at 24 fps

- Confirmed active WHIP publishing totaled 33:43 across two segments.
- The glasses briefly lost LAN connectivity; the WHIP reconnect timed out and
  the test was continued in a second session.
- Wall time from the first valid stream to the production 14% cutoff was 35:29.
- The device had already run an approximately 43-second validation stream and
  remained awake during setup after removal from the charger, making this
  result conservative relative to a pristine full-charge start.

#### 1080p at 15 fps

- Confirmed active WHIP publishing totaled 36:19 across three segments.
- The first LAN/ICE disconnect recovered automatically in approximately six
  seconds. A second disconnect was fatal because the WHIP HTTP reconnect
  request timed out, requiring a new test session.
- Total time without valid publishing between the first connection and
  production cutoff was approximately 1:44. Wall time was approximately 38:03.
- Two failed UDP ICE launch attempts and about three minutes of awake
  setup/troubleshooting occurred after the device was unplugged but before the
  measured stream. This makes the runtime conservative.
- The measured sessions used TCP ICE fallback. This differs from the completed
  720p tests and adds a transport variable to direct battery comparisons.

## Test conditions

- Streaming protocol: WHIP with hardware H.264 High Profile Level 4.1 and Opus.
- Network: glasses and MediaMTX ingest server on the same 5 GHz LAN.
- Device monitoring: Wi-Fi ADB only; USB was not connected and could not charge
  the glasses.
- Battery endpoint: the hardware/BES-side battery value reached 14%, triggering
  the normal production stop. Android's framework percentage and charge counter
  were incorrectly frozen during all completed tests.
- Application thermal bitrate scaling: absent in the installed build.
- Android hard thermal protection: enabled.
- WebRTC rate and resolution adaptation: enabled. The configured bitrate is a
  maximum, not a fixed target.
- “CPU/internal heat” is the Android CPU/SoC thermal sensor. It is not an
  exterior surface-temperature measurement. The battery sensor peaked at
  24.9 °C in all completed runs.

## Interpretation

Reducing the requested frame rate from 24 to 15 fps at 720p lowered the
observed peak internal temperature by 6.8 °C. Moving from 720p/15 to 1080p/15
increased peak temperature by 5.1 °C. The 15 fps profiles accumulated more
video time than 720p/24 before the production cutoff, but none of the completed
profiles has a clean, uninterrupted full-charge run yet.

The observed network bitrate was higher in the 720p/15 run than the 720p/24
run despite using fewer frames per second. Both 720p profiles used the same
2.5 Mbps ceiling, and WebRTC rate control varied the actual bitrate with scene
complexity and quality adaptation. Lower FPS should not be presented as a
data-saving measure unless the bitrate ceiling is reduced as well.

Before publishing customer-facing runtime figures, repeat each profile from a
verified full charge at least three times with a controlled scene and no
unexpected camera or network interruption.
