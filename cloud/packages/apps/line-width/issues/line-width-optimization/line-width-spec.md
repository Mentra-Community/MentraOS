# Line Width Optimization Spec

## Overview

Optimize text line width in captions app to maximize characters per line while preventing line overflow on G1 glasses display. New approach: disable mobile wrapping, make cloud the single source of truth, and achieve **100% line utilization** through intelligent character-level breaking.

## Problem

### Problem 1: Double Wrapping

Two independent text wrapping systems cause unpredictable line counts:

1. **Cloud wrapping** (`TranscriptProcessor.ts`) - wraps at visual width units (30/38/44)
2. **Mobile wrapping** (`G1Text.kt`) - wraps at pixel width using `splitIntoLines()`

When cloud sends text with newlines, mobile's `splitIntoLines()` may add MORE newlines if any line exceeds pixel width. This causes:

- Total lines > 5 (hard display limit)
- Line 6+ hidden from user
- Most recent streaming text invisible
- App appears "stuck" or "behind"

### Problem 2: Wasted Line Space (Word Wrap Inefficiency)

Current word-wrap algorithm breaks at word boundaries (spaces), leaving significant unused space:

```
[1]: On purposely not grabbing anybody at    [~70% utilized]
break because I want you all to see how      [~70% utilized]
I'll stop the bridges.                       [~40% utilized]
[1]: I got you all the good stuff.           [~55% utilized]
[1]: Now you have choices.                   [~45% utilized]
```

**Average line utilization: ~56%** - almost half the display is wasted!

With 5 lines max and ~50% utilization, we're effectively showing only 2.5 lines worth of content.

### Problem 3: Speaker Labels on Separate Lines

Speaker labels like `[1]:` sometimes get placed on their own line, wasting an entire line:

```
[1]:                                         [WASTED LINE]
ABCDEFGHIJKLMNOPQRSTUVWXYZ...
```

Should be:
```
[1]: ABCDEFGHIJKLMNOPQRSTUVWXYZ...
```

## Goal: 100% Line Utilization

**Every line should be filled to maximum pixel width (576px).**

Instead of breaking at word boundaries:
```
The quick brown fox jumps over the          [gap]
lazy dog.
```

Break at character level with hyphen:
```
The quick brown fox jumps over the lazy do-
g and continues running across the field.
```

## Pixel Analysis

Using actual G1 font glyph data from `G1FontLoaderKt`:

### Hardware Limits (Verified)

| Constraint | Value |
|------------|-------|
| **Display Width** | 576px |
| **BLE Chunk Size** | 176 bytes |
| **Safe Total Payload** | 390 bytes |
| **Max Lines** | 5 |

### Pixel Width Formula

```
pixel_width = (glyph_width + 1) × 2
```

### Key Character Widths

| Character | Glyph Width | Rendered Width |
|-----------|-------------|----------------|
| `-` (hyphen) | 4px | **10px** |
| ` ` (space) | 2px | **6px** |
| `l`, `i`, `!` | 1px | 4px |
| `a`, `e`, `n` | 5px | 12px |
| `m`, `w`, `M` | 7px | 16px |

### Hyphen-Aware Breaking Math

When breaking a line, we must account for the hyphen's pixel width:

```
MAX_WIDTH = 576px
HYPHEN_WIDTH = 10px

// Wrong approach:
if (current_width > MAX_WIDTH) break;  // Hyphen might overflow!

// Correct approach:
if (current_width + HYPHEN_WIDTH > MAX_WIDTH) {
  // Backtrack to make room for hyphen
  while (current_width + HYPHEN_WIDTH > MAX_WIDTH) {
    remove last character;
    current_width -= char_width;
  }
  add hyphen;
  break;
}
```

**Example:**
```
Line has 570px of text, 6px remaining
Hyphen needs 10px
Current state: 570px + 10px = 580px → OVERFLOW!

Solution: Remove characters until we have 10px+ space
- Remove 'g' (12px) → 558px remaining
- 558px + 10px = 568px → FITS! ✓

Result: "...the lazy do-" (568px) instead of "...the lazy dog" (570px, no room for hyphen)
```

### Edge Cases

1. **Character wider than hyphen**: No problem, removing it creates enough space
2. **Character narrower than hyphen**: May need to remove 2+ characters
   - e.g., removing `l` (4px) isn't enough for `-` (10px), remove another char
3. **Very narrow characters**: `lllllll` - might need to remove 3 chars for one hyphen

## Implementation Strategy

### Phase 1: Character-Level Breaking (Current Goal)

1. **Fill line to max width** - Pack characters until next char would overflow
2. **Account for hyphen** - Reserve 10px for hyphen when breaking mid-word
3. **Add hyphen** - Append `-` at break point
4. **Continue on next line** - Remainder continues without leading hyphen

```typescript
function wrapLineWithHyphenation(text: string, maxWidth: number): string[] {
  const HYPHEN = '-';
  const HYPHEN_WIDTH = 10; // (4 + 1) × 2
  
  const lines: string[] = [];
  let currentLine = '';
  let currentWidth = 0;
  
  for (const char of text) {
    const charWidth = getCharPixelWidth(char);
    
    // Check if char fits (with room for potential hyphen)
    if (currentWidth + charWidth <= maxWidth) {
      currentLine += char;
      currentWidth += charWidth;
    } else {
      // Need to break - but ensure hyphen fits
      while (currentWidth + HYPHEN_WIDTH > maxWidth && currentLine.length > 0) {
        const lastChar = currentLine[currentLine.length - 1];
        currentLine = currentLine.slice(0, -1);
        currentWidth -= getCharPixelWidth(lastChar);
      }
      
      // Don't add hyphen if breaking at space or if line is empty
      if (currentLine.length > 0 && !currentLine.endsWith(' ')) {
        currentLine += HYPHEN;
      }
      
      lines.push(currentLine.trimEnd());
      currentLine = char;
      currentWidth = charWidth;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine.trimEnd());
  }
  
  return lines;
}
```

### Phase 2: Syllable-Aware Breaking (Future Enhancement)

Improve readability by breaking at syllable boundaries:

```
beau-tiful  →  beauti-ful (wrong)  →  beau-ti-ful (correct)
```

Options:
- Use hyphenation library (`hyphen`, `hypher`)
- Dictionary-based lookup
- Language-specific rules

**Deferred** - Character breaking provides 100% utilization; syllables are polish.

### Phase 3: Smart Word-Boundary Preference (Future Enhancement)

Hybrid approach:
1. Try to break at word boundary if within threshold (e.g., 90% line fill)
2. Fall back to character breaking if word boundary wastes too much space

```
if (word_boundary_utilization >= 0.90) {
  break at word boundary (no hyphen, cleaner)
} else {
  break at character (with hyphen, max utilization)
}
```

## Architecture

### Previous Approach (Failed)

Calibrate cloud widths to stay under mobile's pixel limit → Complex, still has double-wrapping

### New Approach: Cloud Single Source of Truth

1. **Disable mobile wrapping** - Remove/bypass `splitIntoLines()` in `G1Text.kt`
2. **Cloud owns all wrapping** - `TranscriptProcessor.ts` handles everything
3. **Pixel-accurate calculations** - Use actual glyph widths, not character counts
4. **Hyphenation support** - Break mid-word when needed for 100% utilization

### Benefits

- Single wrapping system (no double-wrap)
- 100% line utilization (no wasted space)
- Easier debugging (issues always trace to cloud)
- Faster iteration (no mobile app updates for tweaks)
- Preview accuracy (cloud webview matches glasses exactly)

## Constraints

1. **5 lines max** - G1 hardware limit, lines 6+ are hidden
2. **576px max width** - Hardware display limit
3. **390 bytes max payload** - Safe limit for CJK content
4. **Variable font widths** - Must use per-character pixel calculations
5. **Hyphen overhead** - 10px per break point

## Goals

1. **100% line utilization** - Every line filled to max width
2. **Single source of truth** - Cloud controls all text layout
3. **Never exceed 5 lines** - Most recent text always visible
4. **Pixel-accurate breaking** - Account for hyphen width in calculations
5. **Support all scripts** - Latin, CJK, Cyrillic with appropriate handling

## Non-Goals

- Keeping mobile `splitIntoLines()` logic
- Dynamic font size adjustment
- Multi-page text display
- Perfect syllable hyphenation (Phase 1)

## Success Metrics

- **Line utilization ≥ 95%** - Average across all displayed lines
- **Zero overflow** - No line exceeds 576px
- **Zero hidden content** - Never exceed 5 lines
- **Preview matches glasses** - Cloud webview is pixel-accurate

## Open Questions

1. **CJK hyphenation?**
   - CJK languages don't use hyphens for word breaks
   - Can break anywhere (no hyphen needed) - this is actually easier!

2. **Hyphen at line start?**
   - Should continuation lines start with hyphen? (No - standard is hyphen at end only)

3. **Minimum characters before break?**
   - Should we avoid breaking after just 1-2 characters? (e.g., "a-" looks odd)
   - Suggested minimum: 3 characters before hyphen

4. **Speaker label handling?**
   - `[1]: ` should always stay with start of text
   - Never break between `[1]:` and first word

## References

- `G1Text.kt` - Android text width calculation
- `G1FontLoaderKt` - Glyph width data
- `TranscriptProcessor.ts` - Cloud wrapping logic
- Debug tool: `cloud/packages/apps/line-width/`
