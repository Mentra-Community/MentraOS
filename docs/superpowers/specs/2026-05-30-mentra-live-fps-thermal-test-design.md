# Mentra Live: FPS vs. Thermals Test — Design

**Date:** 2026-05-30
**Author:** Alex Israelov
**Status:** Design / ready for implementation
**Linear-ish goal:** Determine whether reducing camera recording FPS makes Mentra Live run cooler, so that long-recording use cases (video fed to AI for analysis — needs readable text, not high motion fidelity) can trade FPS for sustained thermals.

---

## 1. Problem & Hypothesis

Users who record for long periods report the Mentra Live gets too warm. These users need **high quality** (readable text for downstream AI analysis) but **not high frame rate** — the video is fed to AI, not watched. 

**Hypothesis:** Lowering recording FPS at a fixed 1080p resolution reduces sensor readout + ISP + encoder load, lowering sustained device temperature, without hurting the "readable still frame" quality these users actually care about.

**Test:** Record 1080p at 30 / 15 / 5 fps, each to thermal steady-state, and compare temperatures across all on-device thermal zones.

---

## 2. Key Findings From On-Device Investigation (2026-05-30)

All of the following were verified live on a connected Mentra Live (`model:Mentra_Live`, MediaTek SoC), not assumed.

### 2.1 Thermals are readable over ADB — no root, no code

`adb shell cat /sys/class/thermal/thermal_zone*/temp` works. 22 zones exposed; temps in **millidegrees C**. Relevant zones (idle baseline shown):

| Zone | `type` | Meaning | Idle °C |
|------|--------|---------|---------|
| `thermal_zone1` | `mtktscpu` | CPU (Philippe's chosen zone) | 31.2 |
| `thermal_zone0` / `16` | `mtktsbattery` / `battery` | Battery | 24.8 |
| `thermal_zone3` | `mtktswmt` | WiFi/BT combo chip | 34.0 |
| `thermal_zone13` | `mtktspmic` | PMIC | 29.0 |
| `thermal_zone19/20/21` | `tzts1` / `tzts2` / `tzts3` | AP / skin / board sensors — **closest to "what the user feels"** | 31–32 |

Zones reading `-127000` (`tzimgs0-5`, `mtktspa`, `mtktscharger*`) are **disabled/unpopulated** — filter them out.

> **Note for the test:** "too warm" is a *case/skin* complaint, so `tzts1/2/3` and `mtktswmt` matter as much as `mtktscpu`. The test sweeps **all** live zones and we pick the most correlated one after seeing data.

### 2.2 FPS *is* requested properly on this sensor — confirmed empirically

The recording FPS (`VideoSettings.fps`) flows to two places:
- `MediaRecorder.setVideoFrameRate(fps)` — encoder cap. (`VideoRecordingSession.java:153-154`)
- Camera capture request `CONTROL_AE_TARGET_FPS_RANGE = Range.create(fps, fps)` — i.e. a **fixed** `[fps,fps]` range. (`PreviewRequestConfigurator.java:38-41`, fed from `CameraNeoService.java:843`)

The sensor advertises these AE target FPS ranges (from `dumpsys media.camera`):
```
[15,15]  [20,20]  [5,30]  [30,30]
```
`[5,5]` and `[15,15]`/`[30,30]` behavior was tested by recording a real clip at each rate and probing the resulting MP4 with `ffprobe`:

| Requested | In advertised fixed ranges? | **Actual captured FPS** | Verdict |
|-----------|------------------------------|--------------------------|---------|
| 30 | yes (`[30,30]`) | **29.6 fps** | honest |
| 15 | yes (`[15,15]`) | **14.6 fps** | honest |
| 5  | **no** (but inside `[5,30]`) | **5.0 fps** | honest — HAL honored 5 via the `[5,30]` range |

**Conclusion:** On *this* sensor/firmware, all three target rates are captured honestly at the sensor, so **the thermal comparison is valid as-is — the test will not lie.** This was the single biggest risk and it is retired.

### 2.3 Defensive risk (not blocking the test): unvalidated FPS range

The video path sets `Range.create(fps, fps)` **without checking it against `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`** (the code reads those ranges at `CameraNeoService.java:1092` but only uses them for *photo* mode via `FpsRangePolicy`). It worked here because the MediaTek HAL was lenient, but a different sensor/firmware could **reject or silently clamp** an unadvertised `[fps,fps]`. We add a small **snap-to-supported guard** (Section 4.2) so future devices log and use the *actual* range, and so any future surprise is visible, not silent.

### 2.4 Debug-intent delivery — two gotchas, both solved

The existing `IntentCommandReceiver` (`AndroidManifest.xml:162-170`, `exported=true`) routes JSON to the same `CommandProcessor` the phone uses. Driving it from ADB has **two** non-obvious requirements:

1. **JSON escaping.** A naive `am broadcast --es json '{"type":"ping"}'` is mangled: the shell lets `am` interpret the `:` as a data URI (`dat=mId:111`) and the `type` key is lost. **Fix:** wrap the whole `am` invocation in double quotes and escape the JSON's inner quotes:
   ```bash
   adb shell "am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
     -p com.mentra.asg_client \
     --es json '{\"type\":\"start_video_recording\",\"settings\":{\"fps\":15}}'"
   ```
2. **Directed broadcast.** Without `-p com.mentra.asg_client`, the broadcast "completes" but is **silently dropped** by Android's background-execution limits (the app is backgrounded). Adding `-p` (directed broadcast) delivers it. This was the real reason early tests "completed" with no effect.

The `start_video_recording` command **already accepts** `settings: {width, height, fps}` (`VideoCommandHandler.java:113-130`); fps is validated by `VideoSettings.isValid()` as `fps > 0 && fps <= 60`. **No new intent extra is needed to control FPS.**

### 2.5 Bitrate is constant across FPS — important for interpretation

Video bitrate is fixed by resolution, not FPS: 16 Mbps for width ≥ 1920 (`VideoRecorderPolicy.java:32-34`). So file size ≈ bitrate × duration regardless of FPS (confirmed: 30fps and 5fps clips were both ~21.7 MB for ~10.6 s). **Any thermal delta therefore comes from sensor readout + ISP + per-frame encode work, not from data volume.** This is the cleanest possible isolation of "FPS effect" and should be stated in the results.

---

## 3. Approach (chosen)

**Code-free ADB harness for the measurement + a small defensive code guard for FPS validity.**

Rationale: The answer can be obtained with zero build/flash because FPS control and thermal reads both already work over ADB (verified §2.1–2.4). We ship the measurement harness now to get data fast. We *also* land the snap-to-supported FPS guard (§4.2) because it's cheap, makes future devices honest, and turns a silent failure mode into a logged one. Full app-side thermal logging / a product FPS setting is deferred to a follow-up that depends on the test outcome.

### Alternatives considered
- **Pure code-free, no guard:** fastest, but leaves the unvalidated-range footgun for the next sensor. Rejected — guard is cheap.
- **Full app-side thermal logging + product FPS setting now:** durable, but requires replacing the factory system app (loses OTA), slow to iterate, and premature before we know FPS even helps. Deferred.

---

## 4. Components

### 4.1 Measurement harness — `asg_client/scripts/fps-thermal-test.sh`

A single bash script run from the dev machine against a USB-connected Mentra Live. Responsibilities:

**Preflight (fast, ~10 s):**
- Confirm exactly one device; abort otherwise.
- Sweep all thermal zones, print `type` + °C, **filter out `-127000`** dead sensors, record which zones are live.
- Dump advertised AE FPS ranges (`dumpsys media.camera | grep -A2 aeAvailableTargetFpsRanges`) and print them.
- For each target FPS (30, 15, 5): warn if `[fps,fps]` is not an advertised fixed range AND fps is not inside an advertised variable range (so the operator knows a clamp is possible on this device).
- Print baseline temps and refuse to start the first run until the device is near idle (configurable threshold on `mtktscpu`, e.g. < 40 °C).

**Per mode (ordered 30 → 15 → 5), for each FPS:**
1. **Cooldown:** poll `thermal_zone1` until it returns within N °C of the run's starting baseline (or a max wait cap), so every mode starts from a comparable thermal floor. Log the cooldown curve.
2. **Start recording** via the directed, escaped broadcast (§2.4) with `settings:{width:1920,height:1080,fps:<fps>}` and a unique `requestId`.
3. **Sample** every ~5 s for ~10 min (configurable): timestamp + every live zone's °C → append to `out/thermal-1080p-<fps>fps.csv`. Also sample `dumpsys thermalservice` headroom if available (best-effort).
4. **Stop recording** (directed, escaped broadcast).
5. **Pull** the resulting `base.mp4`, `ffprobe` its **actual** avg/r frame rate, and assert it's within tolerance of the requested FPS — flag the run if the sensor clamped (defends against §2.3 on other devices).

**Summary:**
- Per mode: steady-state temp (mean of last ~2 min) for each zone, peak temp, and **Δ vs 30 fps**.
- A one-line verdict per zone: does lower FPS meaningfully reduce steady-state temp (e.g. > 2 °C)?
- Emit a markdown table to `out/SUMMARY.md` plus the raw CSVs.

**Config (env vars or flags):** record duration per mode (default 600 s), sample interval (default 5 s), cooldown target Δ and max wait, resolution (default 1920×1080), FPS list (default `30 15 5`), CPU-zone idle threshold.

**Constants captured from this investigation (so the script is self-contained):**
- Package: `com.mentra.asg_client`
- Action: `com.mentra.asg_client.ACTION_SEND_COMMAND`, extra `json`, **must** use `-p <package>`.
- Capture dir: `/sdcard/Android/data/com.mentra.asg_client/files/com.mentra.asg_client.camera/VID_<ts>_<requestId>/base.mp4`
- CPU zone: `/sys/class/thermal/thermal_zone1/temp` (`mtktscpu`), millidegrees.

### 4.2 Defensive FPS guard (small code change)

In the video capture-request path, before setting `CONTROL_AE_TARGET_FPS_RANGE`:
- Snap the requested `[fps,fps]` to the **nearest advertised** AE range (prefer an exact fixed match; else the tightest advertised range whose bounds contain `fps`; else nearest by distance).
- **Log the requested vs. actually-applied range** at INFO so every recording records what the sensor was really asked to do.

> **Subtlety — don't regress 5 fps on the current device.** Today the code requests `[5,5]` and the MediaTek HAL honors a true 5.0 fps (verified §2.2). If the guard naively snaps `[5,5]` → the advertised **variable** range `[5,30]`, the AE is then free to run the sensor *faster than 5 fps* in bright light (shorter exposures), which would **raise** FPS and confound the thermal test. Therefore the snap must **prefer keeping the fixed `[fps,fps]` request whenever the HAL accepts it** (it does here), and only fall back to a containing variable range when the fixed request is actually rejected. The unit test must cover: exact fixed match → unchanged; unadvertised-but-accepted fixed (the 5 fps case) → unchanged; truly-unsupported → nearest containing range, logged. When in doubt, preserve current on-device behavior — the guard exists to make failures *visible*, not to change what works.

Likely touch points:
- `CameraNeoService.java` already holds `availableFpsRanges` (line 1092). Pass it (or a chosen video range) into `PreviewRequestConfigurator.configure(...)`.
- Add the snap helper next to `FpsRangePolicy` (reuse its range-selection style), e.g. `FpsRangePolicy.chooseVideoFpsRange(availableRanges, requestedFps)`.
- `PreviewRequestConfigurator.java:38-41` uses the snapped range instead of the raw `Range.create(fps,fps)` and logs both.

This is behavior-preserving on the current Mentra Live (the snap returns `[fps,fps]` when advertised, and a sane containing range for 5 fps) and prevents silent clamps elsewhere. Covered by a JVM unit test for the snap helper (`app/src/test/.../camera/policy/`), no device needed.

---

## 5. Test Protocol (operator-facing)

1. Plug in via Infinity Cable; `adb devices` shows `Mentra_Live`.
2. Ensure device is idle/cool (not on charger if possible — charging adds heat; the script notes charger state from `battery`/`mtktscharger` zones).
3. Run `asg_client/scripts/fps-thermal-test.sh` (defaults: 1080p, 30→15→5, 10 min each, 5 s sampling).
4. Let it run unattended (~40–50 min including cooldowns).
5. Read `out/SUMMARY.md`; inspect `out/thermal-1080p-*fps.csv` for the curves.

**Validity gates the script enforces:** single device; live-zone list non-empty; each clip's `ffprobe` FPS within tolerance of requested (else flag clamp); each mode started from a comparable thermal floor.

---

## 5b. Expanded scope — FULL MATRIX (operator requested "test everything")

Beyond the focused 1080p × {30,15,5} thermal-isolation runs, sweep the full grid of what the existing JSON command can drive **with no code changes**:

**Resolutions (app-supported, ffprobe-confirmed on device):** 1280×720, 1920×1080, 2560×1920, 3840×2160 (4K capped to ≤15fps by the app).
**FPS per resolution:** 30, 15, 5 (4K: 15, 5 only).

This is **11 cells**. Each cell records `RECORD_SECS` (default 180s for the full sweep; bump to 600s for the focused steady-state runs), cooled to baseline between cells.

**Bitrate is coupled to resolution, not independent** (`VideoRecorderPolicy.java:32-34`: 16Mbps for width≥1920, 8Mbps for 720p). So the matrix gives us *two* axes for free — FPS effect (within a resolution row, bitrate constant → clean isolation) AND resolution effect (across rows, bitrate changes too). The "bitrate scales with FPS" variant the operator asked about is **not** drivable from the JSON command (no bitrate field) — it requires a code change and is the one deferred item (§6).

**Richer thermal sources** (all confirmed live on device, no root):
- **`dumpsys thermalservice` HAL named sensors:** CPU, GPU, **NPU**, **SKIN** (the user-facing one), BATTERY, POWER_AMPLIFIER — far more meaningful than raw zone numbers.
- **`Thermal Status: N`** — framework throttle severity (0=none … 6=shutdown). **This is the headline "is it overheating?" signal:** any run that pushes status > 0 is the device officially throttling.
- Raw sysfs zones (mtktscpu, mtktswmt, tzts1/2/3, battery, pmic) as a cross-check.
- Throttle proxies: CPU `scaling_cur_freq`, GPU `/sys/kernel/ged/hal/current_freqency` + `gpu_utilization`.

**Output:** per-cell CSV (every sensor, every 5s) + `SUMMARY.md` with a human-readable table (req res/fps, **actual** res/fps from ffprobe, steady-state CPU, peak, Δ-vs-baseline, **maxStatus**, file size) and an FPS-effect breakdown per resolution. Script: `asg_client/scripts/fps-thermal-test.sh`.

## 6. Out of Scope (follow-ups, gated on results)

- App-side continuous thermal logging during streaming/recording (port Philippe's `WhipThermalUtils`/`WhipBitrateTemperatureController` from branch `philippe/os-1244-…`, which is **not in `dev`** — see §2.1) so thermals report over the normal status channel.
- A user-facing / product FPS setting for "long recording / AI analysis" mode.
- Resolution × FPS matrix, or EIS/3DNR on-vs-off thermal effects.
- Streaming (WHIP/RTMP) thermal comparison — this design covers **local recording** only.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sensor clamps an unadvertised FPS on a future device → test lies | §4.2 guard logs actual range; harness asserts MP4 FPS == requested |
| Ambient/charger heat confounds runs | Cooldown-to-baseline between modes; script records charger/battery zone state; recommend off-charger |
| 10 min too short for steady-state | Duration is configurable; summary uses last-2-min mean and also reports slope so non-convergence is visible |
| Background-broadcast drop | Directed `-p` broadcast (§2.4), proven to deliver |
| `mtktscpu` not the user-relevant zone | Sweep all zones; pick correlated zone post-hoc (likely `tzts*`/`mtktswmt`) |
