# BLE Photo Quality Improvement Plan

## Problem

Photos transferred over BLE are too low quality to read text. Current "full" size over BLE is 1024x1024 AVIF at quality 35 (~35KB). That's 8 million pixels crammed into 35KB — text is unreadable.

WiFi path sends full 3264x2448 JPEG at 85% quality (~1-2MB) and works great. But users are usually **not on WiFi**, so BLE is the common path in practice.

## Hardware Constraints

- **BES2700 TX buffer**: ~88 packets before overflow
- **Packet size**: ~221 bytes usable
- **Reliable max transfer**: ~19KB (88 x 221 bytes)
- **35KB is already risky** — the code comments say "will likely hit BLE limit"
- **Glasses SoC**: MTK8766, 2GB RAM, 200mAh battery — no room for heavy ML models

**Bottom line: we can't make files bigger. We need to make the same ~35KB contain readable text.**

## Current Architecture

```
SDK sends take_photo command
  ├─ transferMethod="direct" → WiFi upload (full quality, no problem)
  ├─ transferMethod="ble"    → BLE transfer (aggressive compression)
  └─ transferMethod="auto"   → WiFi first, BLE fallback
                                (captures once, re-compresses for BLE if WiFi fails)
```

BLE compression flow (`compressAndSendViaBle()`):
1. Load original full-res JPEG from disk
2. `resolveBleParams(size)` → hardcoded resize + quality targets
3. Resize bitmap (e.g., 3264x2448 → 1024x1024)
4. Encode as AVIF at quality 35 (JPEG fallback at quality 30)
5. Send ~35KB file over BLE

The problem is step 3-4: uniform resize + low quality across the entire image destroys text.

## Proposed Solution: Smart BLE Compression

### Core Idea

Instead of uniformly compressing the entire frame, **detect where the interesting content is** and allocate the byte budget there.

Two compression modes, selected automatically based on image analysis:

| Mode | When | Strategy | Expected Result |
|------|------|----------|-----------------|
| **Text-Optimized** | High edge density detected (document, sign, screen) | Crop to text region + grayscale + sharpen + AVIF at higher quality | Readable text in ~35KB |
| **Standard** | General scene, no text detected | Current AVIF compression (unchanged) | Same as today |

For documents with very high contrast (paper, whiteboard), the text-optimized path applies adaptive thresholding before AVIF encode — this produces near-binary images that AVIF compresses extremely efficiently while staying in the same format.

### Image Analysis (On-Glasses, <50ms)

All of this runs on MTK8766 with zero ML:

**Step 1: Edge density map (~10ms)**
- Downscale to 320x240
- Sobel edge detection (Android `RenderScript` or manual convolution)
- Divide into grid cells (e.g., 8x6)
- Compute edge density per cell

**Step 2: Classify content type (~5ms)**
- **High edge density in concentrated region** → text/document, use Text-Optimized mode
- **Bimodal histogram** (two clear peaks in intensity) → high-contrast document, apply threshold before encode
- **Otherwise** → Standard mode (current behavior)

**Step 3: Find crop region (~5ms)**
- Find bounding box of cells exceeding edge density threshold
- Expand by 10% padding
- This is the ROI (Region of Interest)

### Compression Strategies

#### Text-Optimized Mode
1. **Crop** to detected text region (e.g., 1600x600 from 3264x2448) — **replaces uniform resize**
2. Convert to **grayscale** (3x size reduction at same quality)
3. Apply **unsharp mask** (boosts text edges, survives compression better)
4. If bimodal histogram detected: apply **adaptive threshold** (near-binary, compresses even smaller)
5. Encode as **AVIF at quality 50-60** (can afford higher quality because crop has fewer pixels)
6. Target: ~30-35KB

**Why this works**: A 1600x600 crop is ~12% of the full frame pixels. The crop is at **native sensor resolution** — no downscaling needed. In the same 35KB budget, you get **8x the effective resolution** on the text region. Grayscale buys back another 3x. Net result: the text area gets ~24x more bytes-per-pixel than current approach.

**Resize vs Crop**: Current code resizes the full 3264x2448 frame down to 1024x1024, destroying detail uniformly. Text mode replaces this with a crop — keeping native resolution on the text region. If the crop is still too large pixel-wise (e.g., >1.5M pixels), we resize the crop down, but much less aggressively than resizing the full frame.

#### Standard Mode (unchanged)
Current `resolveBleParams()` behavior. No regression for non-text photos.

## Architecture: Where This Fits

### Current Code Structure

```
PhotoCommandHandler.handleTakePhoto()
  → MediaCaptureService.takePhotoForBleTransfer()
    → compressAndSendViaBle()
      → resolveBleParams(size)     ← hardcoded switch
      → resize bitmap              ← uniform resize of full frame
      → encode AVIF                ← uniform quality
      → send via BLE
```

### Proposed Structure

**Don't touch the command API or transfer method routing.** The `size` parameter and `transferMethod` stay as-is. Smart compression is fully automatic and internal to the BLE path.

```
PhotoCommandHandler.handleTakePhoto()          ← NO CHANGES
  → MediaCaptureService.takePhotoForBleTransfer()   ← NO CHANGES to signature
    → compressAndSendViaBle()
      → NEW: analyzeImage(bitmap)              ← returns ContentType + ROI
      →   if TEXT_OPTIMIZED:
      →     cropToTextRegion(bitmap, roi)      ← replaces uniform resize
      →     convertToGrayscale()
      →     applySharpen()
      →     if highContrast: adaptiveThreshold()
      →     encodeAvif(quality 50-60)          ← higher quality, still AVIF
      →   if STANDARD:
      →     resolveBleParams(size)             ← existing code, unchanged
      →     resize + encodeAvif               ← existing code, unchanged
      → send via BLE                          ← unchanged
```

### New Classes (Minimal)

```
io/media/compression/
  ├── ImageAnalyzer.java         - Edge density, histogram analysis, content classification
  ├── TextOptimizedCompressor.java - Crop + grayscale + sharpen + optional threshold + AVIF encode
  └── BleCompressionResult.java  - Holds compressed byte[] + content type (for logging)
```

Everything stays AVIF. Phone-side assumption unchanged.

**Why separate package**: Keeps `MediaCaptureService` from growing. Each class is testable independently. The analyzer is reusable if we ever want text detection for other features.

### Changes to Existing Files

| File | Change | Scope |
|------|--------|-------|
| `MediaCaptureService.java` | Replace body of `compressAndSendViaBle()` with strategy dispatch | ~30 lines changed |
| `compressAndSendViaBle()` | Call `ImageAnalyzer.analyze()` then dispatch to appropriate compressor | Method body rewrite |
| `PhotoCommandHandler.java` | **No changes** | — |
| `CameraConstants.java` | **No changes** | — |
| `CameraNeo.java` | **No changes** | — |

### What About Auto-Transfer Fallback?

Auto mode captures for WiFi, falls back to BLE via `reusePhotoForBleTransfer()` → `compressAndSendViaBle()`. Since smart compression lives inside `compressAndSendViaBle()`, **it works automatically for fallback too.** The original full-res photo is still on disk — the smart compressor analyzes and crops from that.

Zero changes needed to the auto-transfer path.

## Performance Budget (MTK8766)

| Step | Time | RAM | Notes |
|------|------|-----|-------|
| Load bitmap | ~200ms | ~30MB (3264x2448 ARGB) | Already happening today |
| Downscale for analysis | ~5ms | ~300KB (320x240) | Tiny |
| Edge density computation | ~10ms | ~75KB (grid) | Sobel on 320x240 |
| Histogram analysis | ~2ms | ~1KB | Single pass |
| Crop bitmap | ~5ms | ~3-8MB (crop region) | Bitmap.createBitmap() |
| Grayscale conversion | ~10ms | Same | In-place or new bitmap |
| Unsharp mask | ~15ms | Same | 3x3 convolution on crop |
| Adaptive threshold | ~20ms | Same | Only for high-contrast documents |
| AVIF encode | ~200ms | ~2MB | Already happening today |
| **Total (worst case)** | **~470ms** | **~35MB peak** | vs ~400ms today |

**Added latency: ~70ms.** Negligible. RAM is dominated by the original bitmap load, which already happens.

## What This Doesn't Solve

- **Full page of tiny text**: If the entire frame is small text, there's no good crop — you'd need the whole thing. BLE can't help here. Gallery sync over WiFi later is the answer.
- **Text on busy/textured backgrounds**: Threshold fails, but grayscale + sharpen still helps.
- **Very low lighting**: Everything falls apart. Consider triggering flash LED for text mode.
- **Curved/warped text**: No perspective correction (out of scope, would need ML).

## SDK API

Fully automatic. No SDK API changes. Smart compression is transparent — the glasses automatically detect text and optimize. Apps get better BLE photos without doing anything.

Zero migration, zero SDK changes, benefits all apps immediately.

## Implementation Order

1. **ImageAnalyzer** — edge density + histogram analysis + content classification + ROI detection
2. **TextOptimizedCompressor** — crop + grayscale + sharpen + optional threshold + AVIF encode
3. **BleCompressionResult** — simple wrapper for compressed bytes + content type for logging
4. **Integration into `compressAndSendViaBle()`** — strategy dispatch, Log.d for mode selected
5. **Testing on device** — photograph documents, signs, screens, and normal scenes

## Success Criteria

- Text on a document/sign photographed from ~1 foot is **readable** after BLE transfer
- Non-text photos (scenes, faces) are **no worse** than current quality
- Added latency < 100ms on MTK8766
- No increase in BLE transfer file size (still ~35KB max)
- All output is AVIF (no format changes for phone-side)
- No changes to SDK API
