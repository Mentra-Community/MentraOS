# Swappable text ROI models

## Objective

The text ROI pipeline finds the area of a photo that contains text. It does **not**
recognize or transcribe the text: there is no OCR step. On Mentra Live, detection
and cropping run on the glasses before encoding and BLE transfer so that fewer
image bytes need to cross BLE.

The desktop benchmark makes detector choices comparable before validating them
on the MT8766 hardware. Desktop timings are comparative only; they do not
predict on-device latency, memory use, or thermal behavior.

## Detector roster

The stable detector ids are:

| Detector id | Family | Expected ONNX filename |
| --- | --- | --- |
| `classical` | Existing OpenCV pipeline | None |
| `swt` | Stroke Width Transform / classical | None |
| `mser_only` | MSER / classical | None |
| `ml_kit` | Bundled/offline Google ML Kit text recognizer | None (bundled model, no asset) |
| `ppocr_v6_tiny_det` | PaddleOCR DBNet | `ppocr_v6_tiny_det.onnx` |
| `ppocr_v5_mobile_det` | PaddleOCR DBNet | `ppocr_v5_mobile_det.onnx` |
| `ppocr_v6_small_det` | PaddleOCR DBNet | `ppocr_v6_small_det.onnx` |
| `fast_tiny` | FAST | `fast_tiny.onnx` |
| `fast_small` | FAST | `fast_small.onnx` |
| `east_lite` | EAST | `east_lite.onnx` |
| `yolo_nano_text` | YOLO | `yolo_nano_text.onnx` |

`ml_kit` requires no model file: it uses Google's bundled/offline ML Kit text
recognizer (`com.google.mlkit:text-recognition`), which ships its model inside
the app and needs no Play Services or network access. It decodes and analyzes
the original sensor JPEG bytes itself (see `MlKitTextRoiDetector` and its
`roi/MlKitRoiDetector` adapter) rather than pre-extracted luma, and its
crop is already in source-pixel coordinates
(`TextRoiDetector#returnsNativeCoordinates()` returns `true`), unlike the
classical/ONNX detectors, which analyze a subsampled luma buffer and need the
caller to scale their result back up.

Only the code adapters and runners for the ONNX-based models ship in this
repository. Model `.onnx` files are intentionally **not committed**. For an
Android/device build, place the needed files, with the exact names above,
under:

```text
app/src/main/assets/textroi/
```

For the desktop harness, keep models outside the repository if desired and pass
their containing directory with `--model-dir`.

## Preparing models

Model provenance, licensing, and accuracy must be reviewed before distribution.
Do not rename an arbitrary model to one of the expected filenames: each adapter
has an input and output contract.

For PP-OCR detection models, obtain the appropriate Paddle inference model and
convert it with a compatible Paddle-to-ONNX tool. A command template is:

```bash
paddle2onnx \
  --model_dir <paddle-inference-model-dir> \
  --model_filename <inference-model-file> \
  --params_filename <inference-params-file> \
  --save_file <expected-name>.onnx \
  --opset_version <supported-opset> \
  --enable_onnx_checker True
```

Before using the result, inspect it with an ONNX checker/runtime and verify the
actual contract. The current DBNet runner supplies normalized NCHW float input
at `640x640` and expects a probability map shaped like `[1,1,H,W]`,
`[1,H,W]`, or `[H,W]`. Export options, preprocessing, output activation, and
tensor layout must match the source model; conversion success alone is not
contract verification.

Export FAST, EAST, and YOLO from their original framework using that
framework's supported ONNX exporter, then simplify or optimize only if the
result remains numerically equivalent. Verify each exported graph in ONNX
Runtime against known images:

- FAST uses normalized NCHW float input at `640x640` and must expose a
  segmentation probability map compatible with the DBNet-style shapes above.
- EAST uses normalized NCHW float input at `320x320` and must expose a
  `[1,1,H,W]` score tensor plus a `[1,5,H,W]` geometry tensor.
- YOLO uses normalized NCHW float input at `640x640` and must expose detections
  compatible with `[1,N,5+]` / `[N,5+]` or transposed `[1,4+C,N]` /
  `[4+C,N]` output. Generic object-detection weights are unsuitable:
  `yolo_nano_text.onnx` must use text-trained weights.

For every family, confirm channel order, normalization, resizing behavior,
dynamic/static dimensions, output tensor order and shape, coordinate units,
confidence semantics, and representative output against the corresponding
runner before device testing.

## Run the desktop benchmark

From `asg_client/`:

```bash
./scripts/textroi-benchmark.sh \
  --input "/path/to/text photos" \
  --detectors classical,swt,mser_only
```

To compare neural models and estimate transfer time at a measured BLE rate:

```bash
./scripts/textroi-benchmark.sh \
  --input "/path/to/text photos" \
  --output "/tmp/textroi results" \
  --model-dir "/path/to/onnx models" \
  --detectors classical,ml_kit,ppocr_v5_mobile_det,fast_tiny,east_lite,yolo_nano_text \
  --ble-bytes-per-second 30000
```

`ml_kit` needs no `--model-dir` entry - it runs from the bundled model as soon
as it is included in `--detectors`.

The wrapper runs:

```bash
./gradlew :app:testDebugUnitTest --tests '*TextRoiBenchmarkHarnessTest'
```

and forwards the selected paths, detector ids, and optional BLE rate as
`-Dtextroi.*` system properties. It prints the output directory before and
after the run. The harness writes per-image detector results and aggregate
benchmark data there. Review detector id (including fallback), detection
outcome, ROI coordinates and dimensions, source/cropped byte counts, crop
ratio, inference/detection latency, and estimated BLE transfer and total
detection-plus-transfer time. Also inspect the generated crop/overlay artifacts
for missed, clipped, or excessive regions; aggregate metrics alone cannot prove
crop correctness.

## Device selection and lifetime

`AsgConstants.ENABLE_MODEL_TEXT_CROP` controls whether
`AsgConstants.TEXT_CROP_MODEL` is selected. When the flag is `false`, the
service uses `classical` regardless of `TEXT_CROP_MODEL`. When `true` (the
default in production), `TEXT_CROP_MODEL` currently selects `ml_kit`. When a
requested ML Kit or ONNX model cannot be loaded or initialized, the detector
falls back to the classical pipeline and reports that explicitly:

```text
<requested-model-id>->classical
```

Treat the arrow in a reported detector id as a failed model run, not as
performance from the requested detector.

The service lazily creates and caches its detector, including the ONNX Runtime
session, for the `MediaCaptureService` lifetime. Cleanup closes the detector and
its session. Do not create a new ONNX session for every photo.

## ONNX Runtime is excluded from the default build

`app/build.gradle` declares the Android ONNX Runtime artifact as `compileOnly`,
not `implementation`. This keeps `ai.onnxruntime.*` resolvable so the ONNX
detector classes always compile, but its native libraries (`libonnxruntime.so`,
`libonnxruntime4j_jni.so`, tens of MB per ABI) are **not packaged** into a
default APK/AAB, since the shipped text-crop path uses the classical detector
or bundled ML Kit, neither of which needs ONNX Runtime, and no `.onnx` model is
committed to this repo.

Enable packaging only for a build that will actually exercise an ONNX
detector:

```bash
./gradlew assembleDebug -PenableTextRoiOnnx=true
# or
ENABLE_TEXT_ROI_ONNX=true ./gradlew assembleDebug
```

Measured on this repo's debug build: a default `assembleDebug` packages no
`libonnxruntime*.so` at all; `assembleDebug -PenableTextRoiOnnx=true` adds
about 46 MB (`arm64-v8a` + `armeabi-v7a` combined) versus the default build.
Because a debug APK is unstripped and uncompressed, a release AAB's per-ABI
download size will differ; re-measure with `assembleRelease` /
`bundleRelease` before relying on a specific number.

If a build without `enableTextRoiOnnx` ever selects an ONNX `TextCropModel`
(e.g. a misconfigured `AsgConstants.TEXT_CROP_MODEL`), `OrtEnvironment`/
`OrtSession` construction throws `NoClassDefFoundError` (a `LinkageError`)
because the real classes were never packaged; `TextRoiDetectorFactory` already
catches `Exception | LinkageError` and falls back to the classical detector,
so this is safe by construction, not just by convention.

## MT8766 physical-device validation

Before enabling a model for Mentra Live, validate a representative photo set on
physical MT8766 glasses:

- Confirm crop correctness for small, rotated, low-contrast, distant, and
  edge-of-frame text, plus scenes with no text.
- Measure cold initialization and warm per-photo detection latency.
- Measure end-to-end crop, encode, and BLE total time at realistic throughput;
  a smaller crop is not beneficial if detection costs more time than it saves.
- Soak repeated captures and monitor sustained latency, CPU load, temperature,
  and thermal throttling.
- Record native/Java memory before initialization, at steady state, and after
  service cleanup; check for growth across captures and service restarts.
- Compare debug/release APK size with every candidate model asset included.
- Verify missing, corrupt, and incompatible model files produce a reported
  `<requested-model-id>->classical` fallback and still return a safe crop.
- Confirm service cleanup releases ONNX resources and subsequent service startup
  can initialize the detector again.
