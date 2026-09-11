# Mentra Live — FPS vs Thermals (recording)

**Date:** 2026-05-30 · Device: Mentra Live (MediaTek) · Charger: OFF

- 180s recording per setting, sampled every 5s, cooled to ~39°C baseline before each cell.
- Baseline CPU (mtktscpu): 36.1°C. `steadyCPU` = mean of last 1/3 of samples.
- `maxStatus` = peak framework thermal-throttle severity (0=none … 6=shutdown). 0 everywhere = no run hit throttling in 180s (each started from a cooled floor).
- Bitrate is app-derived: **16 Mbps for 1080p, 8 Mbps for 720p** — constant across FPS within a resolution, so the FPS delta is pure frame-rate work, not data volume.
- Every clip ffprobe-verified for actual captured resolution + FPS (✓ = matched request).

> **Note:** 1440p (2560×1920) and 4K (3840×2160) are NOT physically supported by this
> sensor (max output is 1440px wide). The app wrongly advertises them; requesting them
> fails to record AND wedges the camera (requires app restart). Those cells are excluded.

## Results

| Resolution | FPS | Actual | Steady CPU | Peak CPU | ΔvsBase | Status | Size |
|---|---|---|---|---|---|---|---|
| 1280×720  | 30 | 720p@29.6 ✓  | 51.7°C | 53.9°C | +15.6°C | 0 | 182.7 MB |
| 1280×720  | 15 | 720p@14.6 ✓  | 46.9°C | 47.3°C | +10.8°C | 0 | 181.4 MB |
| 1280×720  | 5  | 720p@5.0 ✓   | 42.2°C | 43.3°C | +6.1°C  | 0 | 173.0 MB |
| 1920×1080 | 30 | 1080p@29.6 ✓ | 58.1°C | 59.6°C | +22.0°C | 0 | 362.8 MB |
| 1920×1080 | 15 | 1080p@14.6 ✓ | 49.2°C | 49.9°C | +13.1°C | 0 | 360.0 MB |
| 1920×1080 | 5  | 1080p@5.0 ✓  | 43.5°C | 44.0°C | +7.4°C  | 0 | 369.5 MB |

## FPS effect (steady-state CPU)

| FPS drop | 720p | 1080p |
|---|---|---|
| 30 → 15 | −4.8°C | **−8.9°C** |
| 30 → 5  | **−9.5°C** | **−14.6°C** |
| 15 → 5  | −4.7°C | −5.7°C |

**Conclusion:** Lowering recording FPS is a large, monotonic thermal lever. At 1080p,
30→5 fps cuts CPU temp ~14.6°C (58.1 → 43.5°C); 30→15 fps already saves ~9°C. For
video fed to AI (text/quality matters, motion fidelity doesn't), **1080p@5fps runs
~14°C cooler than the default 1080p@30fps** while keeping full resolution and *sharper*
per-frame quality (same 16 Mbps spread over 6× fewer frames).

Per-cell CSVs (CPU/GPU/NPU/SKIN/BATTERY/PA + throttle status + CPU freq) and the
recorded clips are alongside this file. Raw rows: `.rows`.
