# Glasses Line Overflow Spec

## Overview

The TranscriptProcessor formats text based on character count, but the glasses render based on visual pixel width. This mismatch causes lines to overflow and wrap on the glasses, pushing content beyond the visible 5-line display area.

## Problem Analysis

### Current Architecture

```
TranscriptProcessor.processString(text)
    ↓ formats to N lines × M chars
DisplayManager.showOnGlasses(formattedText)
    ↓ sends pre-formatted text
Glasses.showTextWall(text)
    ↓ renders with internal font
    ↓ wraps lines that exceed pixel width
    ↓ OVERFLOW: more lines than expected!
```

### The Disconnect

| Component | Line Length Calculation |
|-----------|------------------------|
| TranscriptProcessor | Character count (e.g., 52 chars) |
| Glasses Display | Pixel width (e.g., 640px) |

These are not equivalent when dealing with variable-width characters.

### Character Width Analysis

For a typical glasses font:

| Character Type | Approximate Width Ratio |
|---------------|------------------------|
| Latin lowercase (a-z) | 1.0x |
| Latin uppercase (A-Z) | 1.2x |
| Numbers (0-9) | 1.0x |
| Punctuation | 0.5-1.0x |
| Chinese/Japanese/Korean | 1.8-2.0x |
| Emoji | 2.0x+ |

### Example Calculation

**Settings**: 52 chars per line, 5 lines max

**Input text with Chinese**:
```
锅台明，这个就是他的名字，他叫锅台明。他送给，送给，送给就是 give，送给
```

**Character count**: ~55 characters (seems close to 52 limit)

**Visual width calculation**:
- 45 Chinese chars × 2.0 = 90 units
- 10 Latin/punctuation × 1.0 = 10 units
- Total: 100 units (vs 52 unit max!)

**Result**: Line wraps to 2 lines on glasses, pushing other content off-screen.

## Current Handling

### TranscriptProcessor

```typescript
// src/app/utils/text-wrapping/TranscriptProcessor.ts

constructor(maxCharsPerLine: number, maxLines: number, ..., isChinese: boolean) {
  this.maxCharsPerLine = maxCharsPerLine  // e.g., 52 for wide
  this.isChinese = isChinese
}

private wrapText(text: string, maxLineLength: number): string[] {
  // Uses character count for splitting
  if (this.isChinese) {
    splitIndex = findChineseWordBoundary(text, maxLineLength)
  } else {
    // Find last space before maxLineLength
  }
}
```

### convertLineWidth (Real-World Testing Results)

```typescript
// src/app/utils/convertLineWidth.ts - CURRENT VALUES

export function convertLineWidth(width: string, isHanzi: boolean): number {
  const widthMap = isHanzi 
    ? { narrow: 10, medium: 12, wide: 14 }  // Very conservative for Hanzi
    : { narrow: 30, medium: 38, wide: 44 }  // Tested safe for Latin
  // ...
}
```

**Real-world testing found:**
- Latin: Over 44 chars causes wrapping on glasses → **44 is the safe max**
- Hanzi: Pure Chinese might be ~18 chars, but set to **14 to try to handle mixed**
- **Mixed content STILL wraps even at 14 chars** because `isHanzi` is per-session, not per-line

**The fundamental problem**: The `isHanzi` flag is set once for the session based on language setting, but actual content is mixed Chinese + English. A line like:

```
他送给，送给，送给就是 give，送给 example, I can say
```

Gets the 14-char Hanzi limit applied, but:
- The English portions take less visual space than Chinese
- So the processor allows more characters than expected
- Result: Still overflows on glasses

**Conclusion**: Per-session language detection cannot solve this. We need **per-character visual width calculation**.

## Chosen Solution: Visual Width Calculation

The only way to maximize characters per line while never overflowing is to calculate visual width per-character. This handles any mix of languages automatically.

Calculate actual visual width instead of character count:

```typescript
function getVisualWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (isCJKCharacter(char)) {
      width += 2.0
    } else if (isEmoji(char)) {
      width += 2.0
    } else if (isUpperCase(char)) {
      width += 1.2
    } else {
      width += 1.0
    }
  }
  return width
}

function wrapTextByVisualWidth(text: string, maxVisualWidth: number): string[] {
  const lines: string[] = []
  let currentLine = ""
  let currentWidth = 0

  for (const word of splitIntoWords(text)) {
    const wordWidth = getVisualWidth(word)
    
    if (currentWidth + wordWidth > maxVisualWidth) {
      lines.push(currentLine.trim())
      currentLine = word + " "
      currentWidth = wordWidth + 1
    } else {
      currentLine += word + " "
      currentWidth += wordWidth + 1
    }
  }
  
  if (currentLine.trim()) {
    lines.push(currentLine.trim())
  }
  
  return lines
}
```

**Why this is the only solution that works:**
- Maximizes characters per line (no wasted space)
- Handles pure Latin, pure CJK, and mixed content automatically
- No per-session language detection needed
- Accurate for any language combination

**Tuning needed:**
- CJK width ratio: Start with 2.0x (based on 44 Latin → ~22 CJK equivalence)
- Safety margin: 5-10% to account for font variations

## Implementation Plan

### Phase 1: Add Visual Width Utilities

Create new utility functions:

```typescript
// src/app/utils/text-wrapping/visualWidth.ts

export function isCJKCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
    (code >= 0x3000 && code <= 0x303F) ||   // CJK Punctuation
    (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
    (code >= 0xAC00 && code <= 0xD7AF)      // Korean Hangul
  )
}

export function getCharWidth(char: string): number {
  if (isCJKCharacter(char)) return 1.8
  if (isFullWidthChar(char)) return 2.0
  return 1.0
}

export function getTextVisualWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += getCharWidth(char)
  }
  return width
}
```

### Phase 2: Update TranscriptProcessor

Modify `wrapText` to use visual width:

```typescript
private wrapText(text: string, maxVisualWidth: number): string[] {
  const result: string[] = []
  let remaining = text
  
  while (remaining.length > 0) {
    // Find the longest prefix that fits within maxVisualWidth
    let splitIndex = this.findVisualWidthBreakpoint(remaining, maxVisualWidth)
    
    const line = remaining.substring(0, splitIndex).trim()
    result.push(line)
    remaining = remaining.substring(splitIndex).trim()
  }
  
  return result
}

private findVisualWidthBreakpoint(text: string, maxWidth: number): number {
  let width = 0
  let lastBreakpoint = 0
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    width += getCharWidth(char)
    
    // Track word boundaries for cleaner breaks
    if (char === ' ' || this.isChinese) {
      lastBreakpoint = i + 1
    }
    
    if (width > maxWidth * 0.95) {  // 5% safety margin
      return lastBreakpoint > 0 ? lastBreakpoint : i
    }
  }
  
  return text.length
}
```

### Phase 3: Update Width Settings

Define widths in visual units (Latin char = 1.0 unit):

```typescript
// src/app/utils/text-wrapping/convertLineWidth.ts

// Based on real-world testing: 44 Latin chars is safe max
const VISUAL_LINE_WIDTHS = {
  narrow: 30,
  medium: 38,
  wide: 44,
}

// No separate Hanzi widths needed - visual width handles it automatically!
// The processor will calculate that 44 visual units ≈ 22 CJK chars

export function convertLineWidth(width: string | number): number {
  // Now returns visual units, not character count
  // Works for ALL languages automatically
}
```

This means:
- Pure Latin: ~44 chars per line (wide)
- Pure CJK: ~22 chars per line (wide) 
- Mixed 50/50: ~30 chars per line (wide)
- All calculated dynamically based on actual content!

### Phase 4: Update Preview

Ensure the webview preview uses the same visual width logic:

```typescript
// The preview should render with a font that has similar proportions
// to the glasses font, so visual width calculations match
```

## Testing Plan

### Test Cases

1. **Pure Latin text**
   - Should fill lines efficiently
   - No overflow on glasses

2. **Pure Chinese text**
   - Lines should be shorter (fewer chars)
   - Each line should fit on glasses

3. **Mixed Chinese + English**
   - Variable line lengths based on content
   - No overflow regardless of mix ratio

4. **Japanese (Kanji + Hiragana)**
   - Similar to Chinese handling
   - Word boundaries respected

5. **Korean (Hangul)**
   - Correct width calculation
   - Proper line breaks

6. **Emoji in text**
   - Wide characters handled correctly
   - No line overflow

7. **Edge cases**
   - Very long words without spaces
   - URLs in transcription
   - Numbers mixed with text

### Validation Method

For each test:
1. Send text through TranscriptProcessor
2. Verify output has ≤ 5 lines
3. Verify each line's visual width ≤ max
4. Confirm on real glasses: no overflow, all lines visible

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/utils/text-wrapping/visualWidth.ts` | New file - visual width utilities |
| `src/app/utils/text-wrapping/TranscriptProcessor.ts` | Use visual width for wrapping |
| `src/app/utils/convertLineWidth.ts` | Simplify to visual units |
| `src/app/session/SettingsManager.ts` | Update width interpretation |

## Success Criteria

- [ ] Chinese text displays correctly on glasses (no overflow)
- [ ] Japanese text displays correctly on glasses
- [ ] Mixed language text displays correctly
- [ ] Preview accurately reflects what glasses show
- [ ] No regression for pure Latin text
- [ ] All 5 lines remain visible in all scenarios

## Open Questions

1. **What are the exact font metrics for glasses?**
   - Need to measure actual character widths on Even Realities G1
   - May vary by firmware version

2. **Should we query glasses for display capabilities?**
   - Would be most accurate
   - Requires API support

3. **How to handle edge cases like URLs?**
   - Very long "words" with no break points
   - May need forced character breaks
