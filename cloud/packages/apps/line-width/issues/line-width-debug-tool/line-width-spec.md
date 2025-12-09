# Line Width Debug Tool Spec

## Overview

A debug application to discover and validate optimal text wrapping logic for G1 glasses display by testing actual pixel widths against glasses firmware behavior.

## Current Problem: Wasted Line Space

The current word-wrap algorithm breaks at word boundaries (spaces), leaving significant unused space:

```
[1]: On purposely not grabbing anybody at    [~70% utilized]
break because I want you all to see how      [~70% utilized]
I'll stop the bridges.                       [~40% utilized]
[1]: I got you all the good stuff.           [~55% utilized]
[1]: Now you have choices.                   [~45% utilized]
```

**Average line utilization: ~56%** - almost half the display is wasted!

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

### Hyphen-Aware Breaking Math

The hyphen `-` has a pixel width that must be accounted for:
- Hyphen glyph: 4px → rendered: **10px** (using formula: (4+1)×2)

When breaking a line:
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

Result: "...the lazy do-" (568px) instead of overflow
```

### Edge Cases for Hyphen Math

1. **Character wider than hyphen**: No problem, removing it creates enough space
2. **Character narrower than hyphen**: May need to remove 2+ characters
   - e.g., removing `l` (4px) isn't enough for `-` (10px), remove another char
3. **Very narrow characters**: `lllllll` - might need to remove 3 chars for one hyphen

### Implementation Phases

**Phase 1: Character-Level Breaking** (Current Goal)
- Break at last character that fits
- Account for hyphen width in calculations
- Guarantees 100% utilization

**Phase 2: Syllable-Aware Breaking** (Future)
- Use hyphenation dictionary/library
- Break at syllable boundaries for readability
- `beau-ti-ful` instead of `beauti-ful`

## ✅ Complete Character Support Findings

### Hardware Limits

| Constraint | Value |
|------------|-------|
| **Display Width** | 576px |
| **BLE Chunk Size** | 176 bytes |
| **Safe Total Payload** | 390 bytes |
| **Max Lines** | 5 |

### Character Support Matrix

| Script | Pixels/Char | Max/Line | Status | Notes |
|--------|-------------|----------|--------|-------|
| **Latin narrow** (l, i, !, .) | 4px | 144 | ✅ Works | |
| **Latin average** (a, e, n, o) | 12px | 48 | ✅ Works | |
| **Latin wide** (m, w, M, W) | 16px | 36 | ✅ Works | |
| **Numbers** (0-9) | ~12px | 49 | ✅ Works | Slightly narrower than letters |
| **Punctuation/Symbols** | ~8.5px | 68 | ✅ Works | Narrower than calculated |
| **Chinese simple** (一, 的, 丨) | 18px | 32 | ✅ Works | |
| **Chinese complex** (國) | 16px | 36 | ✅ Works | Narrower than simple! |
| **Japanese Hiragana** (あ, こ) | 18px | 32 | ✅ Works | Same as Chinese |
| **Japanese Katakana** | 18px | 32 | ✅ Works | Same as Chinese |
| **Japanese Kanji** | 18px | 32 | ✅ Works | Same as Chinese |
| **Korean Hangul** (가, 한) | 24px | 24 | ✅ Works | 33% wider than Chinese/Japanese |
| **Cyrillic** (а, ш) | 18px | 32 | ✅ Works | Renders small but works |
| **Arabic** | - | - | ❌ Not supported | Does not render |
| **Hebrew** | - | - | ❌ Not supported | Does not render |
| **Thai** | - | - | ❌ Not supported | Does not render |
| **Emoji** | - | - | ❌ Not supported | Does not render |
| **Mixed scripts** | - | - | ❌ Not supported | Causes issues |

### Verified Test Results

#### Latin (Confirmed)
```
l × 144 = 576px ✓ (max, 145 wraps)
a × 48  = 576px ✓ (max, 49 wraps)
m × 36  = 576px ✓ (max, 37 wraps)
```

#### CJK (Confirmed)
```
Chinese 一 × 32 = 576px ✓ (max, 33 wraps)
Chinese 的 × 32 = 576px ✓ (max, 33 wraps)
Chinese 國 × 36 = 576px ✓ (max, 37 wraps) - complex chars are narrower!
Japanese hiragana × 32 = 576px ✓
Korean 가 × 24 = 576px ✓ (max, 25 wraps)
Korean 한 × 24 = 576px ✓ (max, 25 wraps)
```

#### Cyrillic (Confirmed)
```
Cyrillic а × 32 = 576px ✓
Cyrillic ш × 32 = 576px ✓
Mixed Russian text ≈ 36 chars with spaces
```

#### Numbers & Symbols (Confirmed)
```
Numbers 0-9 × 49 = 576px ✓
Punctuation/symbols × 68 = 576px ✓
```

## Practical Limits for Implementation

### Latin Characters
| Constraint | Value | Notes |
|------------|-------|-------|
| Max pixel width | **576px** | Use full width |
| Narrow chars (l, i) | **144/line** | 4px each |
| Average chars (a, e) | **48/line** | 12px each |
| Wide chars (m, w) | **36/line** | 16px each |
| Numbers | **49/line** | ~12px each |

### CJK Characters
| Script | Actual Max | Safe Limit | Notes |
|--------|------------|------------|-------|
| Chinese/Japanese | 32/line | **26/line** | Leave room for byte limit |
| Korean | 24/line | **22/line** | Wider characters |

### Byte Limits (Critical for CJK)
```
Max safe payload: 390 bytes

Chinese/Japanese: 26 chars × 3 bytes × 5 lines = 390 bytes ✓
Korean: 22 chars × 3 bytes × 5 lines = 330 bytes ✓

DO NOT EXCEED: ~400 bytes total causes glasses disconnect
```

### Cyrillic
| Constraint | Value | Notes |
|------------|-------|-------|
| Single char repeated | **32/line** | 18px each |
| Mixed text with spaces | **~36/line** | Spaces are narrower |
| Byte size | 2 bytes/char | UTF-8 Cyrillic |

## Pixel Width Formula

For **Latin characters** (verified):
```
pixel_width = (glyph_width + 1) × 2
```

Where glyph_width comes from G1FontLoaderKt:
- Narrow (l, i, !, .): 1px glyph → 4px rendered
- Average (a, e, n): 5px glyph → 12px rendered  
- Wide (m, w, M, W): 7px glyph → 16px rendered
- **Hyphen (-)**: 4px glyph → **10px rendered** (critical for breaking math!)
- **Space ( )**: 2px glyph → 6px rendered

For **CJK characters**:
- Chinese/Japanese: ~18px per character (uniform)
- Korean: ~24px per character (uniform)
- Complex Chinese (國): ~16px per character

For **Cyrillic**:
- ~18px per character (uniform, same as Chinese)

## Unsupported Scripts

The following do **NOT render** on G1 glasses:
- ❌ Arabic (RTL)
- ❌ Hebrew (RTL)
- ❌ Thai
- ❌ Emoji
- ❌ Mixed scripts (e.g., Latin + Chinese in same string)

**Recommendation:** Filter or transliterate unsupported scripts before sending to glasses.

## Implementation Recommendations

### Cloud-Side Wrapping Logic

```typescript
function getMaxCharsPerLine(script: string): number {
  switch (script) {
    case 'latin-narrow': return 144;
    case 'latin-average': return 48;
    case 'latin-wide': return 36;
    case 'numbers': return 49;
    case 'punctuation': return 68;
    case 'chinese':
    case 'japanese': return 26; // Safe limit (32 actual)
    case 'korean': return 22;   // Safe limit (24 actual)
    case 'cyrillic': return 32;
    default: return 36;         // Conservative fallback
  }
}

function getMaxTotalBytes(script: string): number {
  if (['chinese', 'japanese', 'korean'].includes(script)) {
    return 390; // CJK byte limit
  }
  return 500; // Latin/Cyrillic more forgiving
}
```

### Script Detection

```typescript
function detectScript(char: string): string {
  const code = char.charCodeAt(0);
  
  if (code >= 0x4E00 && code <= 0x9FFF) return 'chinese';
  if (code >= 0x3040 && code <= 0x30FF) return 'japanese';
  if (code >= 0xAC00 && code <= 0xD7AF) return 'korean';
  if (code >= 0x0400 && code <= 0x04FF) return 'cyrillic';
  if (code >= 0x0600 && code <= 0x06FF) return 'arabic'; // unsupported
  if (code >= 0x0590 && code <= 0x05FF) return 'hebrew'; // unsupported
  if (code >= 0x0E00 && code <= 0x0E7F) return 'thai';   // unsupported
  if (code >= 0x1F600 && code <= 0x1F64F) return 'emoji'; // unsupported
  if (code >= 0x30 && code <= 0x39) return 'numbers';
  if (code >= 0x21 && code <= 0x2F) return 'punctuation';
  
  return 'latin';
}
```

## Open Questions

1. **Cyrillic rendering quality:** Works but appears small - is this a font issue?
2. **Mixed CJK:** Can Chinese + Japanese mix in same line? (Probably yes, same font)
3. **Firmware updates:** Could future G1 firmware add Arabic/Hebrew/Emoji support?
4. **CJK hyphenation:** CJK doesn't use hyphens - can break anywhere (easier!)
5. **Minimum chars before break:** Should we avoid `a-` style breaks? (Suggest min 3 chars)
6. **Speaker label handling:** `[1]:` should never be separated from text start

## References

- `G1Text.kt` - Android text width calculation
- `G1FontLoaderKt` - Glyph width data
- Debug tool: `cloud/packages/apps/line-width/`
