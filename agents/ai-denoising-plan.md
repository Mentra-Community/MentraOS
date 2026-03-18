# AI Denoising Integration Plan (DnCNN)

## Overview

Add on-device AI denoising to the gallery photo processing pipeline using DnCNN — a lightweight CNN denoiser with MIT-licensed pretrained weights. Runs natively on each platform: TFLite/LiteRT on Android, CoreML on iOS.

## Model

- **Architecture**: DnCNN (17-layer residual CNN: Conv→BN→ReLU × 15 + head/tail)
- **Variant**: `dncnn_color_blind.pth` — color blind denoising (handles unknown noise levels)
- **Source**: [KAIR](https://github.com/cszn/KAIR) by Kai Zhang
- **License**: MIT — commercially safe
- **Parameters**: ~670K
- **Model size**: ~1.5-2MB (FP32), ~1MB (FP16)
- **Input/Output**: RGB image → RGB image (residual learning: output = input - predicted_noise)

## Processing Pipeline (updated)

```
Input JPEG
  → Lens distortion correction (existing)
  → AI denoising (NEW)
  → S-curve tone mapping (existing)
  → Vibrance (existing)
  → Linear color matrix (existing)
  → Output JPEG @ 95%
```

Denoising goes right after lens correction — denoise the clean geometry before applying color adjustments.

## Phase 1: Model Conversion (one-time, Python)

### Prerequisites

```bash
pip install torch onnx onnx2tf coremltools tensorflow
```

### Steps

1. Download `dncnn_color_blind.pth` from [KAIR releases](https://github.com/cszn/KAIR/releases/tag/v1.0)
2. Load in PyTorch using KAIR's `UNetRes`/`DnCNN` class
3. Export to ONNX:
   ```python
   dummy = torch.randn(1, 3, 2448, 3264)  # NCHW, full sensor resolution
   torch.onnx.export(model, dummy, "dncnn_color.onnx",
                      input_names=["input"], output_names=["output"],
                      opset_version=11)
   ```
4. Convert ONNX → TFLite (for Android):
   ```bash
   onnx2tf -i dncnn_color.onnx -o saved_model
   # Then use TFLiteConverter on the saved_model
   ```
   Or use `ai-edge-torch` for direct PyTorch → TFLite.
5. Convert PyTorch → CoreML (for iOS):
   ```python
   import coremltools as ct
   traced = torch.jit.trace(model, dummy)
   mlmodel = ct.convert(traced,
       inputs=[ct.ImageType(name="input", shape=(1, 3, 2448, 3264), scale=1/255.0)],
       compute_precision=ct.precision.FLOAT16)
   mlmodel.save("DnCNN.mlpackage")
   ```
6. Pre-compile CoreML model:
   ```bash
   xcrun coremlcompiler compile DnCNN.mlpackage ios
   ```

### Input Resolution

Fixed input shape of **3264×2448** — full native sensor resolution. No downscaling, no tiling, no quality loss.

DnCNN is only 17 layers of 3×3 conv, so intermediate buffers are ~35MB at full res — well within the capacity of any modern phone. Sync happens in the background so the ~400-800ms inference time is not user-blocking.

### Variable Photo Sizes

The model is exported at a fixed input shape of 3264×2448 (the most common size, since `button_photo_size` defaults to "large"). Photos taken at smaller resolutions (960×720 "small", 1440×1088 "medium") are resized up to 3264×2448 before denoising, then resized back to their original dimensions after. Denoising quality is unaffected — the model just denoises a slightly upscaled image. This keeps us to one model file per platform.

### Low-RAM Safeguard

If the device has **less than 4GB RAM, skip the denoising step entirely**. This avoids OOM on the rare older device while keeping the implementation simple (no tiling fallback).

**Android:**
```java
ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
ActivityManager.MemoryInfo memInfo = new ActivityManager.MemoryInfo();
am.getMemoryInfo(memInfo);
boolean hasEnoughRam = memInfo.totalMem >= 4L * 1024 * 1024 * 1024; // 4GB
```

**iOS:**
```swift
let totalRam = ProcessInfo.processInfo.physicalMemory
let hasEnoughRam = totalRam >= 4 * 1024 * 1024 * 1024 // 4GB
```

Check once at init time, cache the result. If `!hasEnoughRam`, `applyDenoising()` returns the input unchanged.

### Output

- `dncnn_color.tflite` (~2MB) — for Android
- `DnCNN.mlmodelc/` directory (~2MB) — for iOS

Store conversion script in `agents/scripts/convert_dncnn.py` for reproducibility.

## Phase 2: Android Integration

### Files to modify

| File | Change |
|------|--------|
| `mobile/modules/core/android/build.gradle` | Add LiteRT dependencies |
| `mobile/modules/core/android/src/main/assets/dncnn_color.tflite` | Add model file (new) |
| `mobile/modules/core/android/src/main/java/com/mentra/core/utils/ImageProcessor.java` | Add `applyDenoising()` method |

### Gradle dependencies

```gradle
dependencies {
    // existing deps...
    implementation 'com.google.ai.edge.litert:litert:1.0.1'
    implementation 'com.google.ai.edge.litert:litert-support:0.4.0'
    implementation 'com.google.ai.edge.litert:litert-gpu:1.0.1'
}

android {
    aaptOptions {
        noCompress "tflite"
    }
}
```

### ImageProcessor.java changes

**New static fields:**
```java
private static InterpreterApi sInterpreter;
private static boolean sHasEnoughRam = false;
```

**New method: `initDenoiser(Context context)`**
- Lazy-load the TFLite interpreter from assets
- Enable GPU delegate (fall back to CPU if unavailable)
- Called once on first use

**New method: `applyDenoising(Bitmap src)`**
1. If src is not 3264×2448, scale up to model input size
2. Allocate float input buffer [1, 2448, 3264, 3] (NHWC — TFLite convention), normalize pixels to [0, 1]
3. Allocate float output buffer same shape
4. `interpreter.run(inputBuffer, outputBuffer)`
5. Convert output floats back to [0, 255], create Bitmap
6. If original was smaller, scale back to original dimensions
7. Return denoised Bitmap

**Updated `process()` method:**
```java
// Step 1: Lens distortion correction (existing)
// Step 2: AI denoising (NEW)
if (colorCorrection) {
    Bitmap denoised = applyDenoising(result);
    if (denoised != result) { result.recycle(); result = denoised; }
}
// Step 3: Tone mapping (existing)
// Step 4: Color correction (existing)
```

### Context propagation

`applyDenoising` needs Android `Context` to load the model from assets. Options:
- Pass `Context` to `process()` (requires updating the method signature and CoreModule bridge call)
- Or: load the model file path from a known location on disk instead of assets
- Or: initialize the interpreter separately via a static `init(Context)` called from CoreModule on module creation

Recommended: Add a static `init(Context)` method called from `CoreModule.kt`'s `onCreate()`. The interpreter is then available for all subsequent `process()` calls.

## Phase 3: iOS Integration

### Files to modify

| File | Change |
|------|--------|
| `mobile/modules/core/ios/Core.podspec` | Add CoreML/Vision frameworks, model resource |
| `mobile/modules/core/ios/Models/DnCNN.mlmodelc/` | Add compiled model (new directory) |
| `mobile/modules/core/ios/Source/utils/ImageProcessor.swift` | Add `applyDenoising()` method |

### Podspec changes

```ruby
s.frameworks = 'AVFoundation', 'CoreBluetooth', 'UIKit', 'CoreGraphics', 'CoreML', 'Vision'
s.resources = ['Packages/VAD/Silero/Model/*.onnx', 'Models/*.mlmodelc']
```

This follows the existing pattern — ONNX models for Silero VAD are already bundled this way.

### ImageProcessor.swift changes

**New static property:**
```swift
private static var mlModel: MLModel? = {
    guard let url = Bundle(for: BundleToken.self).url(
        forResource: "DnCNN", withExtension: "mlmodelc") else { return nil }
    return try? MLModel(contentsOf: url,
        configuration: { let c = MLModelConfiguration(); c.computeUnits = .all; return c }())
}()
```

**New method: `applyDenoising(_ image: CIImage) -> CIImage`**
1. Render CIImage to CVPixelBuffer at 3264×2448 (scale up if smaller)
2. Create VNCoreMLRequest with the model
3. Run VNImageRequestHandler
4. Get output CVPixelBuffer from VNPixelBufferObservation
5. Convert back to CIImage
6. If original was smaller, scale back to original dimensions
7. Return denoised CIImage

**Updated `process()` method:**
```swift
// Step 1: Lens distortion correction (existing)
// Step 2: AI denoising (NEW)
if colorCorrection {
    image = applyDenoising(image)
}
// Step 3: Tone mapping (existing)
// Step 4: Vibrance (existing)
// Step 5: Color correction (existing)
```

### Bundle token helper

CoreML models loaded from a CocoaPods framework bundle need the correct bundle reference. Add a small helper class if one doesn't exist:
```swift
private class BundleToken {}
// Bundle(for: BundleToken.self) gives the framework's bundle, not the main app bundle
```

## Phase 4: Expo / Build Considerations

### Android
- Model file in `assets/` is automatically included in the APK by Android Gradle Plugin
- `noCompress "tflite"` ensures the model isn't compressed (AGP 4.1+ does this automatically, but explicit is safer)
- LiteRT gradle deps are standard Maven artifacts — no native build issues with Expo

### iOS
- `.mlmodelc` must be pre-compiled before adding to the repo (not `.mlmodel` or `.mlpackage`)
- CocoaPods does NOT auto-compile `.mlmodel` files — this is a known issue
- The podspec `s.resources` glob picks up the `.mlmodelc` directory
- After adding: `cd mobile/ios && pod install && cd ..`
- Then rebuild: `bun ios`
- Do NOT use `expo prebuild --clean` — per project rules, never use `--clean` flag

### App size impact
- Android: ~2MB (model) + ~3-5MB (LiteRT runtime) = **~5-7MB**
- iOS: ~2MB (model) + 0 (CoreML is a system framework) = **~2MB**

## Phase 5: Settings / Gating

Gated behind the existing `media_post_processing` setting (SETTINGS.media_post_processing in settings.ts). When disabled, the entire pipeline is skipped — including denoising.

If we later want independent control, add a separate `ai_denoising` boolean setting. For now, keep it simple — one toggle for all processing.

## Performance Expectations

| Device tier | Resolution | Inference time |
|-------------|-----------|---------------|
| Modern (2022+) GPU/NPU | 3264×2448 | 200-500ms |
| Modern CPU fallback | 3264×2448 | 800-2000ms |
| Older (2019-2021) GPU | 3264×2448 | 400-800ms |
| Older CPU fallback | 3264×2448 | skipped (<4GB RAM) |

Total processing per photo (lens + denoise + tone + color): **400-1000ms** on modern phones.

## Testing

1. Take photos in varied conditions: bright outdoor, indoor, low light, mixed lighting
2. Sync with processing enabled, compare:
   - Noise: visibly reduced in shadows and flat areas
   - Detail: edges and text still sharp (not blurred)
   - Color: no color shifts from denoising (applied before color correction)
3. Compare Android vs iOS output — should be visually consistent
4. Measure processing time on different devices — ensure < 1s total
5. Test with `media_post_processing` toggled off — denoising should be skipped
6. Verify app size increase is within expectations

## Risks

| Risk | Mitigation |
|------|-----------|
| TFLite GPU delegate not available on some Android devices | Fall back to CPU — still < 2s |
| CoreML FP16 artifacts | DnCNN uses only Conv/BN/ReLU — FP16 safe (no LayerNorm/Pow) |
| Model produces over-smoothing on already clean images | DnCNN is conservative by design — residual learning means low-noise images get minimal change |
| Memory pressure on older devices | Skip denoising if <4GB RAM |
| Trained on synthetic Gaussian noise, not real sensor noise | Still effective on high-ISO grain (approximates Gaussian). Consider fine-tuning on real Mentra Live captures later for better results |
| NCHW vs NHWC tensor layout | PyTorch uses NCHW, TFLite uses NHWC. `onnx2tf` handles the transpose automatically — verify during conversion |

## File Inventory (new files)

```
agents/scripts/convert_dncnn.py                    # Conversion script (one-time use)
agents/ai-denoising-plan.md                         # This plan
mobile/modules/core/android/src/main/assets/dncnn_color.tflite   # Android model
mobile/modules/core/ios/Models/DnCNN.mlmodelc/      # iOS model (directory)
```

## References

- [KAIR Repository (MIT)](https://github.com/cszn/KAIR)
- [DnCNN Paper](https://arxiv.org/abs/1608.03981)
- [Pretrained Weights Download](https://github.com/cszn/KAIR/releases/tag/v1.0)
- [LiteRT Android Guide](https://ai.google.dev/edge/litert/android)
- [CoreML Documentation](https://developer.apple.com/documentation/coreml)
- [onnx2tf Converter](https://github.com/PINTO0309/onnx2tf)
