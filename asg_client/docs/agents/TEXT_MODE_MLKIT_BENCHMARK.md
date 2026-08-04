# Mentra Live text-mode detector benchmark and implementation findings

Date: 2026-07-16

Device: Mentra Live, Android 11, MediaTek MT8766B/MT6761-class SoC, 4x Cortex-A53,
2 GB RAM

## Decision

Use bundled ML Kit Latin text recognition as an on-glasses text-region localizer. Warm the
recognizer while the camera captures, run it on an aspect-preserved 1280-pixel-long-edge bitmap,
map the line boxes to the original JPEG, decode only that region, and send one encoded crop. Do not
involve the phone in localization.

This implementation replaces the old OpenCV heuristic detector and does not build on the draft
swappable ONNX detector implementation from PR #3463. The useful idea from that PR was measuring
detectors independently; its model preprocessing, DB postprocessing, fallback, runtime footprint,
and session lifecycle were not suitable for production.

The result meets the detector requirement on the tested device: the final real capture localized
text in 651 ms. The complete post-capture detect/crop/sharpen/JPEG stage took 1,012 ms. Camera
startup and capture remain a separate, pre-existing 2.5-second cold path.

This is a strong implementation candidate, not a production accuracy sign-off. The final release
gate must be an annotated corpus of real glasses captures, because a three-image model bakeoff can
reward a small crop that simply omitted text.

## What `save=false` means

The camera still produces a full-resolution JPEG-encoded buffer. "Retain the JPEG" means retaining
that `byte[]` in memory until detection, crop, encoding, and BLE handoff finish.

- `save=false`: the JPEG is never persisted. It is copied out of `ImageReader`, delivered directly
  to the capture callback, consumed by the BLE worker, and released. The final encoded BLE payload
  is also transferred from a `byte[]`; there is no payload temp file.
- `save=true`: the sensor JPEG remains RAM-only while localization runs. A successful detection
  persists only the full-resolution cropped JPEG; if detection/cropping fails, the retained sensor
  JPEG is persisted as the safe full-frame fallback. EXIF and the IMU sidecar are attached to that
  final selected artifact.
- The existing IMU recorder still uses a small `.jsonl.partial` scratch file during capture. The
  claim here is specifically that `save=false` does not write the multi-megabyte JPEG or encoded
  BLE payload.

An ADB filesystem check after the final `save=false` run found an empty request directory and no
`base.jpg`.

A separate `save=true` device run localized two lines in 594 ms and wrote exactly two files: a
183,436-byte cropped `base.jpg` plus the 3,125-byte `imu.json` sidecar. The capture directory did
not contain the 12 MP sensor JPEG or a temporary selected JPEG.

## End-to-end pipeline

1. Receive `take_photo` with `mode=text`.
2. Start warming the bundled ML Kit recognizer while Camera2 meters and captures.
3. Copy the sensor JPEG from `ImageReader` to memory.
4. Decode a sampled, aspect-preserved 1280-long-edge analysis bitmap.
5. Run ML Kit and union its line boxes.
6. Map the union back to 4032x3024 source coordinates and add padding.
7. If only one line was found, add asymmetric object context. This lets an ordinary small label
   pull in nearby stylized text that ML Kit did not box.
8. Use `BitmapRegionDecoder` on the in-memory JPEG so only the selected source region is decoded.
9. Do not upscale a small crop. Sharpen and encode JPEG at quality 80.
10. Hand the encoded bytes directly to the UART/BLE transport.
11. On no text, timeout, decode error, or detector error, send the full frame at the selected
    quality. Uncertainty never causes a destructive center crop.

Android's `BitmapRegionDecoder` supports JPEG and can be constructed from an input stream, so the
source does not need to become a file ([Android API reference](https://developer.android.com/reference/android/graphics/BitmapRegionDecoder)).

## Final physical-device run

The scene was a curved product label with both conventional small text and large stylized text.
The request used a 4032x3024, 3,765,995-byte sensor JPEG, `mode=text`, `size=high`, and
`save=false`.

| Stage | Measured time |
| --- | ---: |
| Command to accepted camera job | 24 ms |
| Cold command to JPEG bytes available | 2,478 ms |
| ML Kit text localization | 651 ms |
| ROI-only JPEG decode, output 824x1216 | 128 ms |
| Sharpen | 106 ms |
| JPEG encode | 113 ms |
| Full post-capture compression stage | 1,012 ms |
| Command to encoded payload ready in RAM | 3,528 ms |

The selected source ROI was `[1653,713][2477,1929]`. The encoded 824x1216 JPEG was 281,446
bytes (274.8 KiB), a 92.5% reduction from the sensor JPEG. The synthetic ADB request had no phone
transfer consumer, so the later packet timeout is not a completed BLE throughput result and is not
counted as detector or compression latency.

## Analysis-resolution sweep

The same saved 4032x3024 capture was run three times at each analysis size. Detection quality was
judged visually, not from OCR strings.

| Analysis long edge | Detector times | Lines | Quality result |
| ---: | --- | ---: | --- |
| 480 | 732, 221, 176 ms | 0, 0, 0 | Reject: missed the text |
| 640 | 413, 274, 263 ms | 0, 0, 0 | Reject: missed the text |
| 800 | 382, 380, 502 ms | 1, 1, 1 | Only the conventional line; stylized text missed |
| 960 | 1,069, 438, 658 ms | 0, 0, 0 | Reject: unstable miss |
| 1280 | 691, 384, 426 ms | 2, 2, 2 | Best: retained the conventional and stylized label regions |

This is why production uses 1280 rather than the faster 640 result from the initial simple-text
capture. Google's own guidance says each character should ideally have at least 16x16 pixels,
that focus and resolution materially affect results, and that lower resolution trades accuracy for
latency ([ML Kit Android guide](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)).

## Pipeline optimization runs

These adjacent physical captures show what reduced the callback-to-payload time. Scene-dependent
ROI size means payload bytes are not directly comparable across every row.

| Variant | Detector | Decode | Payload | Post-capture stage |
| --- | ---: | ---: | ---: | ---: |
| 640 analysis, full 12 MP decode, crop upscaled | 557 ms | about 256 ms | 102.3 KB | 1,201 ms |
| 640 analysis, full decode, no upscaling | 690 ms | about 256 ms | 16.0 KB | 1,128 ms |
| 640 analysis, ROI-only decode, no upscaling | 661 ms | 97 ms | 13.2 KB | 890 ms |
| 1280, tight one-line ROI | 713 ms | 100 ms | 21.3 KB | 962 ms |
| 1280, very broad one-line context | 652 ms | 143 ms | 330.2 KB | 1,066 ms |
| 1280, final bounded asymmetric context | 651 ms | 128 ms | 274.8 KB | 1,012 ms |

The tight one-line result was fast but visually unsafe: the detected conventional line did not
guarantee that the nearby stylized product text was included. The final padding deliberately spends
bytes for recall. This is the right direction for a payload that will later be read by a human or
VLM.

## Camera CPU profile and the apparent 600 ms versus 150 ms gap

The camera does consume substantial CPU while it is held warm, but the earlier comparison
overstated its effect on ML Kit. Percentages below are normalized so 100% means one fully occupied
core; the device has four cores.

| Five-second state | ASG app | `camerahalserver` | `cameraserver` | `system_server` | `surfaceflinger` |
| --- | ---: | ---: | ---: | ---: | ---: |
| Camera closed | 1.3% | 0.0% | 0.0% | 0.0% | 0.0% |
| Warm preview, interval 1 | 13.4% | 95.9% | 10.0% | 5.2% | 1.6% |
| Warm preview, interval 2 | 12.8% | 95.0% | 9.8% | 5.8% | 1.8% |

`dumpsys media.camera` confirmed that warm-up configures two outputs: a 320x240 YUV preview and a
4032x3024 JPEG still surface. The still surface produced no frames while parked, but the preview
produced approximately 30 frames per second despite the requested `[5,30]` AE range. MediaTek HAL
threads such as `fpipe.g_p2a`, `3ATHREAD`, `p2_streaming`, `CAM_P1`, and `CAM_P2` accounted for the
HAL load. The ASG app also acquires and immediately discards every YUV preview image so the
`ImageReader` queue does not stall. CPU 0/1 rose from about 1.53 GHz at idle to the 2.001 GHz maximum
during preview.

Therefore, “camera warm-up uses 100% CPU” is directionally true for the camera HAL: it uses about
one full Cortex-A53 core. It does **not** mean all four cores are saturated. The measured camera
processes and ASG preview draining together consumed roughly 1.3 core-equivalents, before kernel
and unlisted work.

The production camera also keeps that repeating preview alive for three seconds after a still. In
one traced capture the camera connected at 21:13:16, delivered JPEG bytes at 21:13:18, ran ML Kit
for 449 ms while the preview remained active, and disconnected at 21:13:21. This overlap is real
and wastes compute for text mode.

It does not, however, establish a same-workload 600 ms versus 150 ms camera penalty:

- The approximately 150 ms result came from a 640-long-edge/simple-text case. The difficult label
  needed 1280 pixels for acceptable recall; 480 and 640 missed it entirely.
- With the camera closed, the identical saved label at 1280 took 529, 416, and 694 ms in a fresh
  run (an earlier run was 691, 384, and 426 ms).
- Immediate real 1280 captures took 449-651 ms. That range overlaps the camera-closed range and
  shows considerable model/runtime scheduling jitter.

The correct conclusion is that the three-second post-capture preview is expensive and should be
disabled for text mode, but it is not the primary explanation for the fourfold headline gap. A
proper implementation should carry an explicit `closeAfterCapture` policy into `CameraNeoService`
and release the session immediately after publishing the in-memory JPEG. Calling the existing
`closeKeptAliveCamera()` from the media callback is racy because the callback can start before the
camera thread has transitioned into its IDLE keep-alive state. This optimization should be measured
with the same JPEG, 1280 analysis size, model instance, and thermal state before claiming a latency
win.

### Comparison with a real WHIP stream

A local MediaMTX WHIP ingest was run over ADB-forwarded WebRTC/TCP so the measurement included a
negotiated peer connection and actual published media, without internet variability. The default
WHIP configuration requested 854x480 at 15 fps and 1 Mbps. The camera selected 960x720 at a fixed
15 fps; WebRTC cropped/scaled it, negotiated H.264, encoded through
`OMX.MTK.VIDEO.ENCODER.AVC`, and published H.264 plus Opus audio.

| Five-second state | ASG app | Camera HAL | Camera server | Audio HAL | Hardware codec | System server | Listed total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Warm photo preview, average | 13.1% | 95.5% | 9.9% | 0.0% | 0.0% | 5.5% | 124.0% |
| Live WHIP, interval 1 | 57.3% | 41.9% | 4.6% | 21.7% | 9.9% | 5.4% | 140.8% |
| Live WHIP, interval 2 | 57.6% | 42.5% | 4.8% | 21.4% | 9.7% | 4.8% | 140.8% |

Again, 100% is one core and 400% is the four-core device. The supposedly idle photo warm-up uses
about 88% of the listed CPU used by a complete WHIP video+audio stream. It is therefore high for an
idle grace period, even though it is not evidence of a runaway loop: Camera2 frame counts matched
the requested work and the load was stable. The main reason is configuration. Photo warm-up selects
the flexible `[5,30]` AE range and ran at 30 fps in the measured lighting, while WHIP locks the
camera to 15 fps. WHIP moves more work into the app, audio HAL, and hardware encoder, but its camera
HAL load is less than half the warm-photo HAL load.

The current evidence supports an expected detector saving of roughly 50-100 ms from closing the
camera, with a plausible per-shot range from effectively zero to about 150 ms. It does not support
hundreds of milliseconds as a reliable claim: closed-camera 1280 runs already varied by 278 ms,
and immediate live runs overlap that range. The larger and more certain benefit is eliminating
roughly 1.2 core-equivalents for the remainder of the three-second keep-alive, reducing energy,
heat, and contention during ROI decode/sharpen/encode. A controlled A/B implementation is required
for a tighter latency number.

## Earlier candidate bakeoff and why its results looked poor

### PR #3463 implementation

The draft PR resized every frame to a fixed 640x640 square, converted it to luma, replicated that
channel three times, and used a generic connected-component postprocessor for DB detector output.
Official PaddleOCR uses aspect-preserving, 32-aligned resizing, color-aware normalization, polygon
scoring, minimum-area rotated boxes, and polygon unclipping. The PR was therefore benchmarking an
incorrect pipeline, not just an old or bad model.

| Detector/runtime on Mentra Live | Warm detector result |
| --- | ---: |
| PR PP-OCRv6 tiny, ORT CPU | about 900 ms and zero-box fallback |
| PR PP-OCRv5 mobile, ORT CPU | about 1,160 ms and clipped band |
| PR PP-OCRv6 small, ORT CPU | about 1,729 ms and clipped band |
| PR PP-OCRv6 tiny, XNNPACK | 1,504-1,627 ms in full captures |

XNNPACK being slower is not surprising in itself: ONNX Runtime recommends measuring each model and
device, and warns that unsupported partitions and data-copy overhead can degrade accelerated paths
([ONNX Runtime mobile guidance](https://onnxruntime.ai/docs/tutorials/mobile/)). Its XNNPACK provider
is optimized for Arm floating-point inference, but that does not guarantee a win for every graph
([XNNPACK provider](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html)).

The full two-ABI ONNX Runtime dependency also increased the measured universal release APK by
47.61 MiB. The 1.7 MiB model was not the main package cost.

### Corrected PP-OCRv6 tiny baseline

An independent detector-only port used the official preprocessing and DB postprocessing on the
same glasses. Three warm calls followed one warmup.

| Threads | Long edge | Detector times | Result |
| ---: | ---: | --- | --- |
| 1 | 480 | 474, 459, 456 ms | Correct simple line |
| 2 | 480 | 327, 319, 314 ms | Correct simple line |
| 4 | 320 | 164, 160, 161 ms | Reject: clipped most of line |
| 4 | 480 | 273, 266, 265 ms | Correct simple line |
| 4 | 640 | 445, 432, 432 ms | Correct simple line |
| 4 | 960 | 962, 919, 913 ms | Correct, no useful latency tradeoff |

So PP-OCRv6 is not intrinsically a one-second detector. The prior greater-than-one-second result
was mostly pipeline distortion, runtime configuration, and excess pixels. However, the corrected
480 case missed smaller text in a second capture, while 640 took 575-622 ms and produced an overly
large region. ML Kit offered a simpler integration and better observed small-text localization.

PaddleOCR's current model table lists PP-OCRv6 tiny as a 1.9 MB, 0.43M-parameter edge/IoT detector;
PP-OCRv6 small is 9.6 MB; PP-OCRv5 mobile reports 57.77/28.15 ms CPU time on Paddle's much faster
reference machine. Those numbers are useful model metadata, not predictions for this A53 device
([current PaddleOCR model table](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html)).

### Classical baselines

Classical, SWT, and MSER ran in roughly 10-18 ms in the host harness, but visual review showed
missed/clipped text and 67-100% fallback rates. On glasses they took 123-242 ms in the full Java
pipeline and still produced untrustworthy center fallbacks. Their low latency did not make their
crops safe.

## Why ML Kit

- It is bundled and immediately available offline. The alternative Play Services flavor can need
  a first-run model download, which is unacceptable for glasses capture. Google documents about a
  4 MB increase per script per architecture for the bundled flavor
  ([bundled versus unbundled](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)).
- It provides line bounding boxes even though this product does not need OCR strings.
- It avoids a separate model conversion, ONNX runtime, native DB postprocessor, and session-close
  race.
- It stayed below one second immediately after real camera capture on the tested device.
- Empty or failed detection safely degrades to a full-frame transmission.

ML Kit is not magically perfect. Recognition-oriented training can miss logos, stylized lettering,
very small text, blur, glare, and arbitrary scripts. Contextual padding mitigates but cannot prove
that missed text is inside the crop.

## Remaining validation before production rollout

Build and annotate at least 150-300 real Mentra captures spanning documents, product labels,
screens, street/store signs, handwriting, multiple scripts, rotations, blur, glare, low light,
text at every edge/corner, spatially separated text, and no-text scenes.

Release metrics should prioritize:

1. Percentage of readable ground-truth text polygons fully contained in the transmitted image,
   including margin. A clipped or missed text count is more important than byte savings.
2. Detector and complete callback-to-payload p50/p95/p99 immediately after capture, not only after
   the device settles.
3. Actual transmitted bytes and completed phone-consumed BLE time.
4. Peak PSS/native heap, battery drain, temperature, and throttling over at least 50 captures.
5. Fallback rate and reason, selected ROI, line count, analysis size, and stage timings in telemetry.

Candidates worth revisiting only if ML Kit fails the recall gate are corrected PP-OCRv6 tiny/small
with a custom reduced runtime, ncnn, or a high-recall classical ensemble. Do not add seven model
families speculatively; every candidate must have reproducible weights, preprocessing,
postprocessing, licensing, and physical-device evidence.

## Reproduction

Run focused unit and compile checks:

```bash
cd asg_client
./gradlew :app:compileDebugJavaWithJavac \
  :app:testDebugUnitTest \
  --tests '*MlKitTextRoiDetectorTest' \
  --tests '*CapturedPhotoTest' \
  --no-daemon
```

For the detector sweep, push a JPEG and run the instrumentation benchmark:

```bash
adb push capture.jpg /sdcard/Download/mlkit-benchmark.jpg
cd asg_client
./gradlew :app:installDebug :app:installDebugAndroidTest --no-daemon
adb shell am instrument -w \
  -e class com.mentra.asg_client.io.media.core.textdetect.MlKitTextRoiDetectorBenchmarkTest \
  com.mentra.asg_client.test/androidx.test.runner.AndroidJUnitRunner
```

The benchmark logs `MLKIT_BENCH` rows for 480, 640, 800, 960, and 1280 long-edge inputs.
