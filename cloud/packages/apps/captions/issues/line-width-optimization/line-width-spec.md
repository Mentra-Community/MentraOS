# Line Width Optimization Spec

## Overview

Optimize text line width in captions app to maximize characters per line while preventing line overflow on G1 glasses display. New approach: disable mobile wrapping, make cloud the single source of truth.

## Problem

Two independent text wrapping systems cause unpredictable line counts:

1. **Cloud wrapping** (`TranscriptProcessor.ts`) - wraps at visual width units (30/38/44)
2. **Mobile wrapping** (`G1Text.kt`) - wraps at pixel width using `splitIntoLines()`

When cloud sends text with newlines, mobile's `splitIntoLines()` may add MORE newlines if any line exceeds pixel width. This causes:

- Total lines > 5 (hard display limit)
- Line 6+ hidden from user
- Most recent streaming text invisible
- App appears "stuck" or "behind"

## Pixel Analysis

Using actual G1 font glyph data from `G1FontLoaderKt`:

### Display Math

```
DISPLAY_WIDTH = 488px
Space glyph = 2px + 1px spacing = 3px, then *2 = 6px
Margin = 5 spaces × 6px = 30px per side
Effective width = 488 - (2 × 30) = 428px
```

### Current Cloud Settings vs Reality

| Setting     | Chars | Pixel Width | Fits in 428px?         |
| ----------- | ----- | ----------- | ---------------------- |
| Narrow (30) | 30    | 360px       | ✅ YES (68px headroom) |
| Medium (38) | 38    | 456px       | ❌ NO (-28px over)     |
| Wide (44)   | 44    | 528px       | ❌ NO (-100px over)    |

### Key Finding

**Both "Medium" and "Wide" settings exceed mobile's effective width**, causing mobile to re-wrap and potentially exceed 5 lines.

### Character Limits (for 'a' = 5px glyph width)

| Scenario                  | Max Chars         |
| ------------------------- | ----------------- |
| Without speaker label     | 35 chars          |
| With `[1]: ` label (30px) | 33 + 5 = 38 total |

### Real-World Text

Real sentences fit better due to narrow chars (i, l, spaces):

```
"Hello there how are you doing today my friend" (45 chars) = 410px ✅
"The quick brown fox jumps over the lazy dog" (43 chars) = 402px ✅
```

## Constraints

1. **5 lines max** - G1 hardware limit, lines 6+ are hidden
2. **Variable font widths** - Pixel width depends on actual glyphs
3. **CJK handling unknown** - Hardcoded glyphs are Latin-only
4. **Speaker labels overhead** - `[1]: ` prefix consumes ~30px per line

## New Approach

### Previous Approach (Failed)

Calibrate cloud widths to stay under mobile's pixel limit → Complex, still has double-wrapping

### New Approach: Mobile Passthrough

1. **Disable mobile wrapping** - Remove/bypass `splitIntoLines()` in `G1Text.kt`
2. **Cloud becomes single source of truth** - All wrapping happens server-side
3. **Empirical calibration** - Test on real hardware to find true limits
4. **Update cloud settings** - Set `VisualWidthSettings` based on hardware testing

### Benefits

- Single wrapping system (no double-wrap)
- Easier debugging (issues always trace to cloud)
- Faster iteration (no mobile app updates for tweaks)
- Preview accuracy (cloud webview matches glasses exactly)

## Goals

1. **Single source of truth** - Cloud controls all text layout
2. **Maximize chars/line** - Use full display width without overflow
3. **Never exceed 5 lines** - Most recent text always visible
4. **Support mixed content** - Latin, CJK, and mixed text

## Non-Goals

- Keeping mobile `splitIntoLines()` logic
- Dynamic font size adjustment
- Multi-page text display

## Open Questions

1. **True hardware pixel limit?**
   - The 488px and margin calculations are from code, not hardware specs
   - Need empirical testing with mobile passthrough

2. **Mobile margin handling?**
   - Currently adds 5-space indent per line
   - Should this move to cloud or stay in mobile?

3. **CJK font handling?**
   - `G1FontLoaderKt` only has Latin glyphs
   - How does mobile render Chinese/Japanese/Korean?
   - What's the fallback glyph width?

4. **Newline preservation?**
   - With wrapping disabled, does mobile preserve `\n` exactly?
   - Any other text processing in the mobile pipeline?

## Success Metrics

- Zero instances of >5 lines on glasses
- Cloud preview matches glasses display exactly
- Wide setting uses >90% of available display width
- Works for Latin, CJK, and mixed content
