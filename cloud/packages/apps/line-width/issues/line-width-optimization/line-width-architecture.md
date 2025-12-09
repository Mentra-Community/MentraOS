# Line Width Architecture

## Current System (Problem)

```
Cloud                              Mobile                         Glasses
──────                             ──────                         ───────
TranscriptProcessor                G1Text.kt
  ├─ buildDisplayText()              ├─ splitIntoLines()  ←── RE-WRAPS
  ├─ wrapTextByVisualWidth()         ├─ adds 5-space margins
  └─ sends text with \n              └─ sends to BLE

Cloud sends 5 lines → Mobile re-wraps → 6+ lines → Line 6 hidden
```

### The Double-Wrapping Problem

Cloud wraps at visual width units (30/38/44 chars), but mobile re-wraps at pixel width (428px effective). When they disagree, lines overflow.

### Pixel Analysis

Using actual G1 font glyph data from `G1FontLoaderKt`:

```
DISPLAY_WIDTH = 488px
Space glyph = 2px + 1px spacing, then ×2 = 6px
Margin = 5 spaces × 6px = 30px per side
Effective width = 488 - 60 = 428px
```

| Cloud Setting | Chars | Pixels | Fits 428px? |
| ------------- | ----- | ------ | ----------- |
| Narrow (30)   | 30    | 360px  | ✅ +68px    |
| Medium (38)   | 38    | 456px  | ❌ -28px    |
| Wide (44)     | 44    | 528px  | ❌ -100px   |

**Both "Medium" and "Wide" exceed mobile's limit.**

## New System (Proposed)

```
Cloud                              Mobile                         Glasses
──────                             ──────                         ───────
TranscriptProcessor                G1Text.kt
  ├─ buildDisplayText()              ├─ passthrough (no wrap)
  ├─ wrapTextByVisualWidth()         ├─ adds margins (TBD)
  └─ sends text with \n              └─ sends to BLE

Cloud sends 5 lines → Mobile passes through → 5 lines on glasses ✅
```

### Key Change

Disable `splitIntoLines()` in mobile. Cloud becomes single source of truth for all text layout.

## Implementation Plan

### Phase 1: Mobile Passthrough

**File**: `mobile/modules/core/android/src/main/java/com/mentra/core/utils/G1Text.kt`

Disable or bypass `splitIntoLines()`:

```kotlin
// Before
val lines = splitIntoLines(text, effectiveWidth)

// After (passthrough)
val lines = text.split("\n")
```

### Phase 2: Empirical Testing

With mobile passthrough enabled:

1. Send test strings of increasing length to glasses
2. Find actual pixel limit where text clips/overflows
3. Test with Latin, CJK, and mixed content
4. Document true hardware limits

### Phase 3: Calibrate Cloud Settings

Update `cloud/packages/apps/captions/src/app/utils/text-wrapping/visualWidth.ts`:

```typescript
// Values TBD based on Phase 2 testing
export const VisualWidthSettings = {
  narrow: TBD, // Conservative
  medium: TBD, // Balanced
  wide: TBD, // Maximum safe
}
```

### Phase 4: Margin Decision

Decide where margin logic lives:

**Option A: Keep in Mobile**

- Mobile adds 5-space indent per line
- Cloud accounts for this in width calculations
- Pro: Less cloud changes
- Con: Split responsibility

**Option B: Move to Cloud**

- Cloud adds indent to each line before sending
- Mobile just passes through
- Pro: Full cloud control
- Con: More bytes over BLE

## Code Paths

### Cloud Wrapping

`cloud/packages/apps/captions/src/app/utils/text-wrapping/TranscriptProcessor.ts`:

```typescript
private wrapTextByVisualWidth(text: string): string[] {
  const safeMaxWidth = this.maxVisualWidth * VISUAL_WIDTH_SAFETY_MARGIN
  const paragraphs = text.split("\n")

  for (const paragraph of paragraphs) {
    // Binary search for break points at visual width limit
    const breakIndex = this.findVisualWidthBreakpoint(remaining, safeMaxWidth)
    // ...
  }
}
```

### Mobile Wrapping (To Be Disabled)

`mobile/modules/core/android/src/main/java/com/mentra/core/utils/G1Text.kt`:

```kotlin
fun splitIntoLines(text: String, maxDisplayWidth: Int): List<String> {
    // ... binary search for pixel width limit
    // This causes double-wrapping - DISABLE THIS
}

fun createTextWallChunks(text: String): List<ByteArray> {
    val effectiveWidth = DISPLAY_WIDTH - (2 * marginWidth)
    val lines = splitIntoLines(text, effectiveWidth)  // ← CHANGE TO PASSTHROUGH
    // ...
}
```

## Open Questions

1. **True hardware limit?**
   - 488px is from code, need to verify on actual glasses
   - May have more/less usable width

2. **Margin ownership?**
   - Keep 5-space indent in mobile, or move to cloud?
   - Affects width calculations

3. **CJK rendering?**
   - `G1FontLoaderKt` only has Latin glyphs (widths 1-7px)
   - Default fallback is 6px width
   - Need to test actual CJK rendering on glasses

4. **BLE packet size?**
   - Does longer text (fewer wraps = longer lines) cause BLE issues?
   - `MAX_CHUNK_SIZE = 176` bytes per packet

## Testing Checklist

After mobile passthrough:

- [ ] Latin text at various lengths
- [ ] Find exact char count where overflow occurs
- [ ] CJK text rendering
- [ ] Mixed Latin/CJK
- [ ] Speaker labels `[N]:` overhead
- [ ] 5 lines max never exceeded
- [ ] Cloud preview matches glasses exactly
