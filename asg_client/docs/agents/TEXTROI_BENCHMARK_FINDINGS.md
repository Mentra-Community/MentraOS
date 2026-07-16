# Text ROI detector benchmark and review findings

Date: 2026-07-16

PR: #3463, `cursor/swappable-text-roi-9c21`

Test device: Mentra Live, Android 11 (API 30), MediaTek MT8766B/MT6761 class SoC, 4x Cortex-A53, 2 GB RAM, PowerVR GE8300 GPU

## Executive decision

The detector interface, factory, model source abstraction, cached-session intent, documentation, and artifact-producing benchmark harness are useful scaffolding. Keep those ideas.

Do not enable or ship the neural crop path in its current form, and do not treat the current benchmark as a model bakeoff. The implementation does not use the official preprocessing or DB postprocessing for the PaddleOCR models; the fallback deletes the outer 25% of the image precisely when detection is uncertain; the benchmark has no text-retention ground truth; and the tested ONNX path is too slow and memory-heavy on Mentra Live.

The current PR should remain a draft or receive changes before merge. A safe merge would need to be explicitly framed as disabled experimental scaffolding, with the issues below tracked and no claim that the listed model families have been validated.

## What was tested

All tests used the PR code at commit `0028ce33180ac7578f78c7836d029d29de90b67c` unless explicitly marked as an external baseline. Test-only model assets and instrumentation were not committed.

- Host harness on three real Mentra captures: one 1920x1080 frame containing a printed line, and two 960x720 low/no-text frames.
- Full capture/compress path on the physical glasses for the three classical options and PP-OCRv6 tiny.
- Direct on-device detector runs against the same 1920x1080 captured frame for PP-OCRv5 mobile, PP-OCRv6 tiny, and PP-OCRv6 small. Each model had one cold-ish measured iteration followed by three warm iterations.
- ONNX Runtime CPU default versus the documented XNNPACK configuration for PP-OCRv6 tiny.
- Bundled ML Kit Latin text recognition as an external, turnkey baseline.
- Clean `origin/dev` versus PR APK-size builds.
- Official PaddleOCR-style preprocessing and DB postprocessing on the host for PP-OCRv5 mobile and PP-OCRv6 tiny.
- One attempted physical BLE transfer. It timed out after packet 88 of 893, so it is not reported as completed goodput.

This is a diagnostic benchmark, not an accuracy study. The image set is far too small to rank models for production.

## Results

### Existing host harness

| Detector | Mean detection | p50 | p95 | Mean JPEG-byte savings | Fallback rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Classical | 14.236 ms | 6.726 ms | 30.897 ms | 71.692% | 66.7% |
| SWT | 10.081 ms | 7.133 ms | 17.855 ms | 62.262% | 100% |
| MSER | 17.657 ms | 15.341 ms | 22.916 ms | 62.308% | 66.7% |

These numbers look favorable but are misleading without ground truth:

- Classical reported `HIGH` confidence and 74.5% byte savings on the text frame, but visual inspection showed that its crop began below the only printed text line.
- SWT included the text band but clipped its top/left portion and then failed its polarity trust check.
- MSER fell back on the text frame and falsely selected bright reflections on a no-text frame.
- A single warmup and one measured call per image cannot produce meaningful percentile estimates.

### Full capture/compress path on Mentra Live

The first four rows used adjacent 1920x1080 captures of the same desk/cup scene. The XNNPACK rows used adjacent 4032x3024 captures after app data was reset by instrumentation.

| Detector/runtime | Detector time | Result | Encoded transfer payload | Observation |
| --- | ---: | --- | ---: | --- |
| Classical | 229 ms | Untrustworthy; 75% center fallback | 339,136 B | Detected components but rejected its own result |
| SWT | 242 ms | Polarity disagreement; 75% center fallback | 339,246 B | No reliable crop |
| MSER | 123 ms | Untrustworthy; 75% center fallback | 357,310 B | No reliable crop |
| PP-OCRv6 tiny, ORT CPU, first | 1,138 ms | Zero boxes; 75% center fallback | 347,589 B | Session initialization was about 575 ms |
| PP-OCRv6 tiny, ORT CPU, next | 1,037 ms | One 236x32 crop, upscaled to 1920x260 | 34,436 B | Crop contained the printed line but clipped it badly and omitted other visible writing |
| PP-OCRv6 tiny, ORT CPU, 4K | 1,198 / 1,051 ms | 24 then 43 components | 410,582 / 307,249 B | Large and unstable union crops on the same scene |
| PP-OCRv6 tiny, XNNPACK, 4K | 1,627 / 1,504 ms | Large horizontal band | about 356-359 KB | Slower than default CPU and still clipped text |

JPEG crop/resize/encode took another roughly 422-466 ms in these runs. The XNNPACK result is model/device-specific, but it disproves the assumption that registering XNNPACK and four threads automatically improves this workload.

### Direct neural detector comparison on Mentra Live

All three models used the PR's exact grayscale-to-three-channel, fixed 640x640 preprocessing and generic postprocessor. The input was the same saved 1920x1080 Mentra capture.

| Model | Model size | Detector times, ms | Warm median | Reported ROI `[x,y,w,h]` | Outcome |
| --- | ---: | --- | ---: | --- | --- |
| PP-OCRv6 tiny | 1.7 MiB | 1031, 923, 900, 900 | 900 ms | `[240,135,1440,810]` | Zero boxes; center fallback |
| PP-OCRv5 mobile | 4.5 MiB | 1299, 1188, 1160, 1157 | 1160 ms | `[0,76,633,67]` | Narrow band touches frame edge and vertically clips the official-model box |
| PP-OCRv6 small | 9.4 MiB | 1865, 1768, 1729, 1729 | 1729 ms | `[0,71,717,78]` | Narrow band touches frame edge and clips the official-model box |

Process PSS before initialization, after initialization, and after four inferences was:

| Model | Before | Initialized | After inference |
| --- | ---: | ---: | ---: |
| PP-OCRv6 tiny | 67,886 KiB | 100,501 KiB | 196,098 KiB |
| PP-OCRv5 mobile | 67,824 KiB | 105,320 KiB | 234,949 KiB |
| PP-OCRv6 small | 67,904 KiB | 117,888 KiB | 235,455 KiB |

The final column includes input/output allocations and test-process overhead, so it is not a pure session-footprint measurement. It still demonstrates material peak-memory pressure on a 2 GB device. In the real capture process, PP-OCRv6 tiny increased PSS by about 125 MB and native heap by about 94 MB after inference.

### Official PaddleOCR pipeline cross-check

The official Android implementation uses color-aware input, aspect-preserving resize aligned to 32, dynamic model shape, polygon scoring, rotated minimum-area boxes, and polygon unclipping. A host script reproducing those important steps at a 640-pixel long edge produced:

| Model | Tensor shape | Host inference | Detected rotated box |
| --- | --- | ---: | --- |
| PP-OCRv6 tiny | 1x3x352x640 | 16.1 ms | `[[62,65],[601,48],[604,146],[65,164]]` |
| PP-OCRv5 mobile | 1x3x352x640 | 12.9 ms | `[[71,78],[580,54],[583,131],[74,154]]` |

Both found the real printed line, and PP-OCRv6 tiny returned no boxes on the no-text frame. These Mac host times are not comparable to the A53 device times. The qualitative result is the important part: the model can work on the image when its intended pipeline is used. The current PR's fixed-square grayscale path is the primary correctness problem, not evidence that PaddleOCR itself is unsuitable.

### ML Kit baseline

Bundled ML Kit Latin text recognition 16.0.1 was run six times on the same frame:

| Input | Timings | Warm median | Output |
| --- | --- | ---: | --- |
| 1920x1080 | 667, 317, 220, 226, 308, 219 ms | 226 ms | 1 block, 1 line, 2 elements; approximate text `SWEE ENER` |
| 640x360 | 205, 185, 437, 295, 308, 261 ms | 295 ms | 1 block, 1 line, 1 element; approximate text `5WEELNEB` |

ML Kit localized the printed line and was much faster than the PR's ONNX path, but recognition was poor and the lower-resolution run was not faster in this small sample. The bundled dependency increased this monorepo's universal APK by about 20 MB in the test build, larger than Google's approximately 4 MB-per-script-per-architecture guidance because both native ABIs were packaged. It is a useful baseline, not an automatic winner.

### APK footprint

Clean, apples-to-apples builds with the same StreamPackLite checkout:

| Build | `origin/dev` | PR with PP-OCRv6 tiny asset | Delta |
| --- | ---: | ---: | ---: |
| Debug APK | 126.74 MiB | 174.37 MiB | +47.62 MiB (+37.57%) |
| Release APK | 121.41 MiB | 169.02 MiB | +47.61 MiB (+39.22%) |

The model is only 1.7 MiB. Most of the increase is the full two-ABI ONNX Runtime package: approximately 26.7 MiB for arm64 `libonnxruntime.so` and 19.1 MiB for armv7. The PR adds the runtime even when model cropping is disabled and no model asset is present.

### BLE

The harness assumes 87,040 B/s, while another document example uses 30,000 B/s. An injected physical transfer initially moved approximately 70 KB/s for the first 88 400-byte packets, then timed out and exhausted retries at packet 88 of 893. This is not a completed throughput measurement. Transfer savings should be calculated from a distribution of completed real transfers rather than a constant.

### Thermal observation

Short capture runs raised reported CPU temperature to roughly 36.9 C, while Android thermal status stayed at 0. This was not a soak test and says nothing about battery impact or sustained throttling.

## Blocking correctness findings

### 1. PaddleOCR preprocessing and postprocessing do not match the model

`AbstractOnnxRoiDetector` resizes every image to a fixed square, takes luma only, replicates it into three channels, and applies ImageNet channel normalization. This distorts 16:9 and 4:3 captures and discards color cues. The official model is dynamic and the official Android pipeline defaults to BGR, aspect-preserving resize, and dimensions aligned to 32.

`OnnxDbNetRoiDetector` then feeds the probability map into a generic connected-component/axis-aligned-box postprocessor. It does not perform the official DB polygon score, rotated minimum-area rectangle, or polygon unclip. This explains the frame-edge bands and vertical clipping observed on device.

Use or faithfully port the official PaddleOCR Android detector preprocessing and DB postprocessing before comparing models. For this device, cap the long edge at 640 or 960 while preserving aspect ratio; do not copy the official demo's generic minimum-side default without measuring it.

### 2. Failure deletes image content

Every empty map, no-box result, inference exception, or untrustworthy classical result returns a centered 75%-by-75% crop. That removes the outer 12.5% on every side when the system has the least evidence about where text is. Edge text is a normal glasses-camera case.

On uncertainty, send the full frame. If bandwidth requires a degraded fallback, send a lower-quality full-frame preview and allow a phone/server decision or a second capture. A center crop must not be called a safety fallback.

### 3. The benchmark rewards destructive crops

The harness reports latency, crop size, JPEG byte savings, and an estimated BLE time, but has no annotated text polygons and no recall/coverage metric. It therefore rewarded a crop that visually missed the only printed line.

The primary release gate must be text retention: all readable ground-truth polygons contained with a margin, plus explicit accounting for clipped and missed text. Byte savings and latency are secondary after correctness.

### 4. Current latency, memory, and package cost are not viable

On this Cortex-A53 device, the fastest neural result was about 900 ms warm before JPEG crop/encode, versus roughly 123-242 ms for classical approaches and 226 ms warm for the ML Kit baseline. ONNX Runtime added about 47.6 MiB to the universal release APK, and inference produced large PSS/native-heap increases.

This cost can exceed the transfer time saved unless the crop is both very small and correct. The only extremely small payload observed was not correct enough to ship.

## Additional implementation findings

1. `MediaCaptureService.cleanup()` can close the cached ONNX session while a background compression task is inside `session.run()`. The `closed` check is not synchronized with close, and `getTextRoiDetector()` can recreate a detector during teardown. Give detector lifecycle to one executor, stop accepting work, drain/cancel it, then close.
2. Factory initialization failures and `LinkageError`s silently return classical detection. The identifier exposes `requested->classical`, but the root cause is lost. This happened on the host when the native ONNX library architecture did not match the JVM. Log and metric the exception and fail the neural benchmark explicitly.
3. The PR creates default `SessionOptions`; it does not configure XNNPACK, NNAPI, or thread counts. XNNPACK was slower in the device test, so runtime/provider tuning must be benchmarked per model rather than assumed.
4. Input construction copies the full luma frame, then allocates roughly 4.7 MiB of float input for 640x640x3, materializes Java output arrays, and causes significant GC/native pressure.
5. The pipeline decodes JPEG to luma, then decodes/crops/resizes/encodes again. Prefer analysis from a camera YUV stream if it can be correlated safely with the still capture. ML Kit also documents direct YUV input as the efficient Camera2 path.
6. A single union rectangle becomes nearly full-frame when text is separated across the image. Preserve multiple polygons internally; consider a multi-crop/mosaic protocol only if layout semantics and receiver compatibility are defined.
7. Selection is compile-time only (`ENABLE_MODEL_TEXT_CROP` and `TEXT_CROP_MODEL`). The abstraction is swappable in code, but not operationally swappable for remote configuration or an A/B rollout.
8. FAST, EAST, and YOLO entries are adapter placeholders. The PR includes no weights, model provenance, license, hashes, or exact tensor contract, so they cannot be reproduced or benchmarked. FAST's published speed relies heavily on GPU/TensorRT and GPU-parallel postprocessing, which is not equivalent to this generic CPU path.
9. The JUnit harness is gated by `assumeTrue`; a green CI run does not mean the benchmark executed. A fresh checkout also required an undocumented StreamPackLite checkout/state.
10. After canonical crop preparation, later logs replace the detector confidence/reason with `PREPARED_CANONICAL_CROP`, reducing observability of false positives and fallback frequency.

## Recommended evaluation plan

### Objective and dataset

Define the objective as preserving all readable text while reducing end-to-end transfer time, not maximizing crop savings.

Build an annotated set of at least 150-300 real Mentra captures covering documents, labels, street/store signs, screens, handwriting, small/large text, rotations, blur, glare, low light, text at every edge/corner, text in separated regions, and no-text scenes. Keep a held-out set and version the annotations.

Primary metrics:

- Ground-truth polygon/box recall and percentage fully contained by the transmitted region plus margin.
- Count of clipped or missed readable text; target zero for a release candidate.
- False crop rate on no-text and uncertain frames.
- Actual transmitted bytes and completed BLE goodput/time.
- Cold and warm preprocess/inference/postprocess/crop/encode p50, p95, and p99.
- Peak PSS/native heap, APK/AAB delivery size, battery drain, temperature, and throttling over at least 50 consecutive captures.

### Candidate matrix

1. Official PaddleOCR Android pipeline, detection only:
   - PP-OCRv6 tiny at aspect-preserved 640 and 960 long edge.
   - PP-OCRv5 mobile at the same sizes.
   - PP-OCRv6 small only if accuracy materially improves enough to justify its measured 1.73 s warm latency.
2. Bundled ML Kit Latin as the turnkey baseline, fed Camera2 YUV rather than a decoded bitmap where possible.
3. Runtime bakeoff for the winning Paddle model:
   - ONNX Runtime default CPU with measured thread counts.
   - A reduced-operator/custom ONNX Runtime arm64 build.
   - ncnn CPU/NEON and Vulkan.
   - Paddle Lite if its current mobile model path remains supported.
4. Classical high-recall baseline after fixing its trust/fallback behavior.

Do not invest in NNAPI on this hardware: no vendor NNAPI service/driver was visible on the device, and Android has deprecated NNAPI in Android 15 in favor of newer runtimes. The PowerVR Vulkan path makes ncnn Vulkan worth measuring, but not assuming.

### Safe transmission policy

1. Analyze an aspect-preserved low-resolution frame.
2. If every detected polygon passes confidence/geometry checks, transmit their union with generous fixed and relative padding.
3. If there is no text or any uncertainty, transmit the full frame, optionally at lower quality, or send a coarse full preview followed by a phone/server retry decision.
4. Record the detector, model/runtime version, confidence, fallback reason, ROI, stage timings, memory, encoded bytes, and final transfer result for every capture.

An initial performance target should be under 200 ms detector time on Mentra Live, subject to the zero-clipped-text gate. The current ONNX implementation is about 4-9x beyond that target.

## Primary references

- [PaddleOCR official Android deployment and benchmark](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/cross_platform/android_deployment.html)
- [PaddleOCR official Android implementation](https://github.com/PaddlePaddle/PaddleOCR/tree/main/deploy/ppocr-android)
- [PaddleOCR text-detection model list](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_detection.html)
- [PaddleOCR ONNX model conversion](https://www.paddleocr.ai/main/en/version3.x/inference_deployment/others/obtaining_onnx_models.html)
- [PaddleOCR on-device deployment with Paddle Lite](https://www.paddleocr.ai/v3.0.2/en/version3.x/deployment/on_device_deployment.html)
- [ONNX Runtime mobile](https://onnxruntime.ai/docs/tutorials/mobile/)
- [ONNX Runtime XNNPACK provider](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html)
- [ONNX Runtime custom builds](https://onnxruntime.ai/docs/build/custom.html) and [reduced operator configuration](https://onnxruntime.ai/docs/reference/operators/reduced-operator-config-file.html)
- [ML Kit Text Recognition v2 for Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)
- [Android NNAPI documentation](https://developer.android.com/ndk/guides/neuralnetworks) and [migration guide](https://developer.android.com/ndk/guides/neuralnetworks/migration-guide)
- [ncnn official repository and deployment features](https://github.com/Tencent/ncnn)
- [FAST paper](https://arxiv.org/abs/2111.02394)

## Bottom line

The PR brings the right architectural question—make text ROI detection replaceable and measurable—but the current implementation answers the model question before defining or measuring the safety objective. Preserve the abstraction and benchmark artifacts; replace the Paddle pipeline with the official algorithm, make uncertainty full-frame-safe, build a ground-truthed Mentra dataset, and then select model/runtime based on text retention first and end-to-end device cost second.
