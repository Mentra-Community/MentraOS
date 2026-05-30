# Mentra Live — Recording FPS vs. Thermals

**Date:** 2026-05-30 · **Device:** Mentra Live (MediaTek SoC)

## TL;DR

Lowering the camera **recording frame rate** is one of the most effective thermal
levers on Mentra Live. At 1080p, dropping from 30 fps to 5 fps cuts steady-state
CPU temperature by **~14.6 °C**; even 30 → 15 fps saves **~9 °C**. Because the
encoder bitrate is fixed per resolution (16 Mbps at 1080p) regardless of frame
rate, this saving is **pure sensor + ISP + encoder frame-rate work** — a clean
result, not a data-volume artifact.

For long recordings whose video is fed to AI (where readable frames matter but
smooth motion does not), **1080p @ 5 fps runs ~14 °C cooler than the default
1080p @ 30 fps** while keeping full resolution and *sharper* individual frames
(the same 16 Mbps spread over 6× fewer frames).

## Results

Each setting recorded 180 s, cooled to a ~39 °C CPU baseline before each run,
sampling every thermal sensor every 5 s. Charger OFF. Every clip was
`ffprobe`-verified to confirm the sensor actually captured the requested fps
(it did: 29.6 / 14.6 / 5.0).

| Resolution | FPS | Actual | Steady CPU | Peak CPU | Δ vs baseline |
| --- | --- | --- | --- | --- | --- |
| 1280×720  | 30 | 720p@29.6  | 51.7 °C | 53.9 °C | +15.6 °C |
| 1280×720  | 15 | 720p@14.6  | 46.9 °C | 47.3 °C | +10.8 °C |
| 1280×720  | 5  | 720p@5.0   | 42.2 °C | 43.3 °C | +6.1 °C  |
| 1920×1080 | 30 | 1080p@29.6 | 58.1 °C | 59.6 °C | +22.0 °C |
| 1920×1080 | 15 | 1080p@14.6 | 49.2 °C | 49.9 °C | +13.1 °C |
| 1920×1080 | 5  | 1080p@5.0  | 43.5 °C | 44.0 °C | +7.4 °C  |

**FPS effect on steady-state CPU:**

| FPS drop | 720p | 1080p |
| --- | --- | --- |
| 30 → 15 | −4.8 °C | **−8.9 °C** |
| 30 → 5  | **−9.5 °C** | **−14.6 °C** |
| 15 → 5  | −4.7 °C | −5.7 °C |

Raw per-cell CSVs (CPU/GPU/NPU/SKIN/BATTERY/POWER_AMPLIFIER, framework throttle
status, CPU freq) and the summary are in [`data/`](./data/).

> A 10-minute worn run at 1080p @ 5 fps plateaued at ~42–43 °C CPU, matching the
> 180 s steady-state figure — confirming 180 s/cell is long enough to read the
> FPS effect.

## Method & device notes

- **Thermals over ADB, no root.** `dumpsys thermalservice` exposes named HAL
  sensors (CPU, GPU, NPU, SKIN, BATTERY, POWER_AMPLIFIER) plus a framework
  **throttle status** (`0` = none … `6` = shutdown). Raw sysfs zones are also
  readable: the CPU zone is `/sys/class/thermal/thermal_zone1/temp` (`mtktscpu`,
  millidegrees). `tzts1/2/3` and `mtktswmt` are the board/skin-adjacent zones.
- **FPS is honored at the sensor.** The camera advertises AE FPS ranges
  `[15,15] [20,20] [5,30] [30,30]`. Requested 30/15/5 fps all produced honest
  captures (the HAL honors 5 fps via the `[5,30]` range even though `[5,5]`
  isn't advertised as a fixed range).
- **Bitrate is fixed per resolution** (16 Mbps ≥ 1080p, 8 Mbps for 720p) — see
  `VideoRecorderPolicy.videoEncodingBitRateForWidth`. So the FPS comparison
  isolates frame-rate work; file size is ~constant across fps within a
  resolution.

## ⚠️ Bug found: 1440p / 4K are advertised but unsupported, and wedge the camera

`VideoSettings.isSupported()` lists `2560×1920` (1440p) and `3840×2160` (4K), but
the Mentra Live sensor's **max output width is 1440 px** (advertised sizes are
`1440×1088 / 1080 / 720`). Requesting 1440p or 4K does **not** record and leaves
the camera **stuck in a half-started recording** that blocks all subsequent
recordings until the app is force-restarted. (Observed during this test: an
`m_2560_1920_15` request hung "recording" for 14 minutes.)

These resolutions were therefore **excluded** from the results above. Recommended
follow-up: validate a requested video size against the sensor's real
`getOutputSizes()` and reject cleanly (or clamp to 1080p) instead of hanging.

## Re-running

[`fps-thermal-test.sh`](./fps-thermal-test.sh) drives the whole sweep over ADB
with no build/flash. It uses the existing `start_video_recording` JSON command
via the `IntentCommandReceiver`.

```bash
# default matrix (720p/1080p × 30/15/5), 180 s/cell, cooldowns between cells
./fps-thermal-test.sh

# shorter smoke run, single cell
RECORD_SECS=60 COOLDOWN=0 MATRIX="1920x1080@5" ./fps-thermal-test.sh
```

**Two ADB gotchas the script handles** (and that anyone driving these commands by
hand will hit):

1. **JSON escaping.** A naive `am broadcast --es json '{"type":"…"}'` is mangled —
   `am` reads the `:` as a data URI. Wrap the whole `am` call in double quotes and
   escape inner quotes: `adb shell "am broadcast … --es json '{\"type\":\"…\"}'"`.
2. **Directed broadcast.** Without `-p com.mentra.asg_client`, Android's
   background-broadcast limits silently drop the command ("Broadcast completed"
   but nothing happens). The `-p` package target is required.
