# Display Utils Library Specification

## Executive Summary

A glasses-agnostic, pixel-accurate text measurement and wrapping library for smart glasses displays. Designed to be reusable across different hardware (G1, future glasses), usable by both the MentraOS SDK (for third-party developers) and internal apps (captions, teleprompter, etc.).

### ⚠️ Key Principle: Pixel-Perfect Measurement (No Averages!)

This library uses **exact pixel widths**, not averages or approximations:

| Script Type | Measurement Strategy | Example |
|-------------|---------------------|---------|
| **Latin** | Per-character glyph map | `'a'` = 12px, `'m'` = 16px, `'l'` = 4px (exact) |
| **CJK** | Uniform width (verified) | ALL Chinese/Japanese chars = 18px (exact) |
| **Korean** | Uniform width (verified) | ALL Hangul chars = 24px (exact) |
| **Cyrillic** | Uniform width (verified) | ALL Cyrillic chars = 18px (exact) |
| **Unknown Latin** | MAX width fallback | Unknown char = 16px (safe, never overflow) |

**We NEVER use "average" character widths for calculation.** The ~12px "average Latin" is documentation only - actual measurement uses exact per-character values from the glyph map.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Architecture Overview](#3-architecture-overview)
4. [Layer 1: Display Profile](#4-layer-1-display-profile)
5. [Layer 2: Text Measurer](#5-layer-2-text-measurer)
6. [Layer 3: Text Wrapper](#6-layer-3-text-wrapper)
7. [Layer 4: Display Helpers](#7-layer-4-display-helpers)
8. [Script & Language Support](#8-script--language-support)
9. [Use Cases & Code Examples](#9-use-cases--code-examples)
10. [Edge Cases & Nuances](#10-edge-cases--nuances)
11. [Migration Plan](#11-migration-plan)
12. [Future Considerations](#12-future-considerations)
13. [References](#13-references)

---

## 1. Problem Statement

### 1.1 Current System Issues

The existing text wrapping system in MentraOS has several fundamental problems:

#### Problem 1: Hardcoded G1 Assumptions

The current `TranscriptProcessor` and `visualWidth.ts` bake in G1-specific values:

```typescript
// Current code - G1 assumptions everywhere
const DISPLAY_WIDTH_PX = 576          // G1-specific
const MAX_LINES = 5                    // G1-specific
this.processor = new TranscriptProcessor(48, 5, 30, true)  // Magic numbers
```

The concept of "visual units" (1 unit = 1 average Latin char = 12px) is a leaky abstraction that's actually G1-specific:

```typescript
// "Visual unit" is secretly G1's pixel math
export const VisualWidthSettings = {
  narrow: 40,   // 40 × 12px = 480px (but why 12px?)
  medium: 48,   // 48 × 12px = 576px
  wide: 52,     // Doesn't even make sense (exceeds display!)
}
```

**Impact:** Cannot easily support new glasses with different displays, fonts, or constraints.

#### Problem 2: Double Wrapping

Two independent systems wrap text:

1. **Cloud** (`TranscriptProcessor.ts`) - wraps at "visual width units"
2. **Mobile** (`G1Text.kt`) - wraps at pixel width using `splitIntoLines()`

When cloud sends pre-wrapped text, mobile may re-wrap, causing:

- Lines exceeding the 5-line hardware limit
- Hidden content (line 6+ invisible to user)
- Unpredictable display behavior

```
Cloud sends (3 lines):     Mobile re-wraps (6 lines):
┌─────────────────────┐    ┌─────────────────────┐
│ Line 1              │    │ Line 1              │
│ Line 2              │ →  │ Line 2 (re-wrapped) │
│ Line 3              │    │ Line 2 cont.        │
└─────────────────────┘    │ Line 3 (re-wrapped) │
                           │ Line 3 cont.        │  ← HIDDEN!
                           │ Line 3 cont.        │  ← HIDDEN!
                           └─────────────────────┘
```

#### Problem 3: Wasted Line Space (Low Utilization)

Current word-wrap breaks at word boundaries, leaving significant unused space:

```
[1]: On purposely not grabbing anybody at    [~70% utilized]
break because I want you all to see how      [~70% utilized]
I'll stop the bridges.                       [~40% utilized]
[1]: I got you all the good stuff.           [~55% utilized]
[1]: Now you have choices.                   [~45% utilized]
```

**Average line utilization: ~56%** — almost half the display is wasted.

With 5 lines max and ~50% utilization, users see only ~2.5 lines worth of actual content.

#### Problem 4: Mixed Concerns

`TranscriptProcessor` handles too many things:

- Text wrapping
- Transcript history management
- Speaker label formatting
- Display line tracking
- Interim vs final handling

This makes it:
- Hard to test individual pieces
- Impossible to reuse for non-caption apps
- Difficult to modify without breaking things

#### Problem 5: App-Specific Logic in Core Utils

Speaker labels (`[1]: `) are baked into the wrapping logic:

```typescript
// Current code mixes generic wrapping with caption-specific formatting
private buildDisplayText(partialText: string, partialSpeakerId?: string): string {
  // ... speaker label logic mixed with text building ...
  result += `[${entry.speakerId}]: ${entry.text}`
}
```

This prevents other apps from using the wrapping utilities without getting caption-specific behavior.

### 1.2 Why We Need New Utils

1. **Hardware Diversity** - G1 is first, but more glasses coming with different specs
2. **SDK Requirement** - Third-party devs need text utilities without caption assumptions
3. **Accuracy** - Need pixel-perfect wrapping to prevent mobile re-wrapping
4. **Utilization** - Want 100% line utilization, not 56%
5. **Maintainability** - Clean separation of concerns for easier development

---

## 2. Goals & Non-Goals

### 2.1 Goals

| Goal | Description |
|------|-------------|
| **Glasses-agnostic** | Support any glasses via configurable profiles |
| **Pixel-accurate** | Measure text in actual pixels, not abstract units |
| **100% line utilization** | Fill lines completely with character-level breaking |
| **SDK-ready** | Clean API for third-party developers |
| **Separation of concerns** | Measurement, wrapping, and formatting as separate layers |
| **Script support** | Latin, CJK, Cyrillic, and all supported scripts |
| **Configurable** | Hyphenation on/off, break modes, prefix support |
| **Testable** | Each component independently unit-testable |

### 2.2 Non-Goals

| Non-Goal | Reason |
|----------|--------|
| App-specific formatting | Speaker labels, transcript history belong in apps, not SDK |
| Dynamic font sizing | Out of scope; glasses have fixed fonts |
| Multi-page/scrolling | Single-screen display only |
| RTL language support | Arabic, Hebrew not supported by current glasses hardware |
| Emoji rendering | Not supported by current glasses hardware |
| Perfect syllable hyphenation | Character breaking is sufficient; syllables are polish |

---

## 3. Architecture Overview

### 3.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Display Utils Library                           │
│                         (@mentra/sdk)                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  LAYER 1: Hardware Abstraction                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                      DisplayProfile                             │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │ │
│  │  │  G1 Profile  │  │ Future Prof. │  │   Custom Profile     │  │ │
│  │  │  576px wide  │  │  ???px wide  │  │   (user-defined)     │  │ │
│  │  │  5 lines max │  │  N lines max │  │                      │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                    │
│                                 ▼                                    │
│  LAYER 2: Text Measurement                                           │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                       TextMeasurer                              │ │
│  │  - measureText(text: string): number  → pixels                  │ │
│  │  - measureChar(char: string): number  → pixels                  │ │
│  │  - fitsInWidth(text: string, maxPx: number): boolean            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                    │
│                                 ▼                                    │
│  LAYER 3: Text Wrapping                                              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                        TextWrapper                              │ │
│  │  - wrap(text, options): string[]                                │ │
│  │  - Options: hyphenate, breakMode, maxLines, maxBytes            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                 │                                    │
│                                 ▼                                    │
│  LAYER 4: Display Helpers (Optional)                                 │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                      DisplayHelpers                             │ │
│  │  - truncateToLines(lines, max): string[]                        │ │
│  │  - estimateLineCount(text): number                              │ │
│  │  - fitToScreen(text, profile): string[]                         │ │
│  │  - calculateByteSize(text): number                              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 │ Used by
                                 ▼
        ┌────────────────────────┴────────────────────────┐
        │                                                 │
        ▼                                                 ▼
┌───────────────────┐                      ┌─────────────────────────┐
│   SDK Consumers   │                      │    MentraOS Apps        │
│   (3rd party)     │                      │                         │
├───────────────────┤                      ├─────────────────────────┤
│                   │                      │  ┌───────────────────┐  │
│  - Teleprompter   │                      │  │   Captions App    │  │
│  - Notifications  │                      │  ├───────────────────┤  │
│  - Custom apps    │                      │  │ CaptionsFormatter │  │
│                   │                      │  │ - speakerLabels() │  │
│  Uses Layers 1-4  │                      │  │ - history mgmt    │  │
│  directly         │                      │  │ (App-specific!)   │  │
│                   │                      │  └───────────────────┘  │
└───────────────────┘                      └─────────────────────────┘
```

### 3.2 Key Design Principles

1. **Pixels are the source of truth** - No abstract "visual units"
2. **Profile-driven** - All hardware specifics come from profile
3. **Composition over inheritance** - Layers compose, don't extend
4. **App owns formatting** - SDK wraps text, apps format content
5. **Explicit newlines** - Apps control line breaks via `\n`, wrapper respects them

---

## 4. Layer 1: Display Profile

### 4.1 Purpose

Define hardware characteristics for any smart glasses display. All downstream calculations derive from this profile.

### 4.2 Interface

```typescript
/**
 * Display profile for a specific glasses model.
 * All text measurement and wrapping derives from this configuration.
 */
interface DisplayProfile {
  /** Unique identifier for this glasses model */
  id: string
  
  /** Human-readable name */
  name: string
  
  /** Display width in pixels */
  displayWidthPx: number
  
  /** Display height in pixels (if applicable) */
  displayHeightPx?: number
  
  /** Maximum number of lines that can be displayed */
  maxLines: number
  
  /** Maximum safe payload size in bytes (for BLE transmission) */
  maxPayloadBytes: number
  
  /** BLE chunk size for transmission */
  bleChunkSize: number
  
  /** Font metrics for text measurement */
  fontMetrics: FontMetrics
  
  /** Optional constraints */
  constraints?: DisplayConstraints
}

/**
 * Font metrics for pixel-accurate text measurement.
 */
interface FontMetrics {
  /** 
   * Map of character to glyph width in pixels.
   * Keys can be single chars or Unicode ranges.
   */
  glyphWidths: Map<string, number>
  
  /** Default glyph width for unmapped characters */
  defaultGlyphWidth: number
  
  /**
   * Formula to convert glyph width to rendered pixel width.
   * G1 example: (glyphWidth + 1) * 2
   */
  renderFormula: (glyphWidth: number) => number
  
  /** 
   * Uniform-width scripts - verified to render all characters at same width.
   * These are NOT averages - they are the actual uniform width.
   */
  uniformScripts: UniformScriptWidths
  
  /**
   * Fallback configuration for unmapped characters.
   */
  fallback: FallbackConfig
}

/**
 * Uniform width scripts - these scripts render all characters at the same width.
 * Verified through hardware testing.
 */
interface UniformScriptWidths {
  cjk: number             // Chinese, Japanese Kanji - all chars same width
  hiragana: number        // Japanese Hiragana - all chars same width
  katakana: number        // Japanese Katakana - all chars same width
  korean: number          // Korean Hangul - all chars same width
  cyrillic: number        // Russian, etc. - all chars same width
}

/**
 * Fallback strategy for unmapped characters.
 */
interface FallbackConfig {
  /** 
   * Max known Latin width for safe fallback.
   * Using max ensures we never overflow (worst case: slight under-utilization).
   */
  latinMaxWidth: number
  
  /** What to do with completely unknown characters */
  unknownBehavior: 'useLatinMax' | 'throw' | 'filter'
}

/**
 * Optional display constraints.
 */
interface DisplayConstraints {
  /** Minimum characters before allowing hyphen break */
  minCharsBeforeHyphen?: number
  
  /** Characters that should not appear at start of line */
  noStartChars?: string[]
  
  /** Characters that should not appear at end of line */
  noEndChars?: string[]
}
```

### 4.3 G1 Profile (Reference Implementation)

```typescript
import { DisplayProfile } from '@mentra/sdk/display-utils'

/**
 * Even Realities G1 Smart Glasses Display Profile
 * 
 * Verified through empirical testing with actual hardware.
 * See: line-width-debug-tool/line-width-spec.md
 */
export const G1_PROFILE: DisplayProfile = {
  id: 'even-realities-g1',
  name: 'Even Realities G1',
  
  // Display dimensions
  displayWidthPx: 576,
  maxLines: 5,
  
  // BLE constraints
  maxPayloadBytes: 390,
  bleChunkSize: 176,
  
  // Font metrics
  fontMetrics: {
    // Glyph widths from G1FontLoaderKt
    // Rendered width = (glyphWidth + 1) * 2
    glyphWidths: new Map([
      // Narrow glyphs (1-2px glyph → 4-6px rendered)
      ['l', 1], ['i', 1], ['!', 1], ['.', 1], [':', 1], ['|', 1],
      ["'", 1], [',', 1], ['j', 2], [';', 1], ['I', 2],
      
      // Average glyphs (3-5px glyph → 8-12px rendered)
      ['a', 5], ['b', 4], ['c', 4], ['d', 4], ['e', 4], ['f', 3],
      ['g', 4], ['h', 4], ['k', 4], ['n', 4], ['o', 4], ['p', 4],
      ['q', 4], ['r', 3], ['s', 4], ['t', 3], ['u', 4], ['v', 4],
      ['x', 4], ['y', 4], ['z', 4], [' ', 2],
      
      // Wide glyphs (6-7px glyph → 14-16px rendered)
      ['m', 7], ['w', 7], ['M', 7], ['W', 7], ['@', 7], ['&', 7],
      
      // Numbers (5px glyph → 12px rendered)
      ['0', 5], ['1', 3], ['2', 5], ['3', 5], ['4', 5],
      ['5', 5], ['6', 5], ['7', 5], ['8', 5], ['9', 5],
      
      // Special characters
      ['-', 4],  // Hyphen: 4px glyph → 10px rendered (CRITICAL for breaking!)
      ['[', 2], [']', 2], ['(', 2], [')', 2],
    ]),
    
    renderFormula: (glyphWidth: number) => (glyphWidth + 1) * 2,
    
    // Uniform-width scripts - ALL characters in these scripts render at this exact width
    // These are verified values, NOT averages
    uniformScripts: {
      cjk: 18,          // ALL Chinese/Japanese chars = 18px (verified)
      hiragana: 18,     // ALL Hiragana chars = 18px (verified)
      katakana: 18,     // ALL Katakana chars = 18px (verified)
      korean: 24,       // ALL Korean Hangul chars = 24px (verified)
      cyrillic: 18,     // ALL Cyrillic chars = 18px (verified)
    },
    
    // Fallback for unmapped Latin characters
    // Uses MAX width to guarantee no overflow (safe under-utilization)
    fallback: {
      latinMaxWidth: 16,  // Max Latin = 'm', 'w' at (7+1)*2 = 16px
      unknownBehavior: 'useLatinMax',
    },
  },
  
  constraints: {
    minCharsBeforeHyphen: 3,
    noStartChars: ['.', ',', '!', '?', ':', ';', ')', ']', '}'],
    noEndChars: ['(', '[', '{'],
  },
}
```

### 4.4 Adding New Glasses

To support new glasses, create a new profile:

```typescript
// future-glasses-profile.ts
export const FUTURE_GLASSES_PROFILE: DisplayProfile = {
  id: 'future-glasses-x1',
  name: 'Future Glasses X1',
  displayWidthPx: 800,           // Different width!
  maxLines: 7,                    // More lines!
  maxPayloadBytes: 500,
  bleChunkSize: 200,
  fontMetrics: {
    glyphWidths: new Map([...]),  // Different font!
    defaultGlyphWidth: 6,
    renderFormula: (gw) => gw * 2,  // Different formula!
    scriptDefaults: { ... },
  },
}

// Usage - everything else stays the same!
const measurer = new TextMeasurer(FUTURE_GLASSES_PROFILE)
const wrapper = new TextWrapper(measurer)
```

---

## 5. Layer 2: Text Measurer

### 5.1 Purpose

Provide pixel-accurate text measurement based on a DisplayProfile. This is the foundation for all wrapping decisions.

### 5.2 Interface

```typescript
/**
 * Measures text width in pixels based on a DisplayProfile.
 * All measurements are in actual pixels, not abstract units.
 */
class TextMeasurer {
  constructor(profile: DisplayProfile)
  
  /**
   * Measure the total pixel width of a text string.
   * @param text - The text to measure
   * @returns Width in pixels
   */
  measureText(text: string): number
  
  /**
   * Measure a single character's pixel width.
   * @param char - Single character
   * @returns Width in pixels
   */
  measureChar(char: string): number
  
  /**
   * Get the raw glyph width (before render formula).
   * @param char - Single character
   * @returns Glyph width in pixels
   */
  getGlyphWidth(char: string): number
  
  /**
   * Check if text fits within a pixel width.
   * @param text - Text to check
   * @param maxWidthPx - Maximum width in pixels
   * @returns true if text fits
   */
  fitsInWidth(text: string, maxWidthPx: number): boolean
  
  /**
   * Find how many characters fit within a pixel width.
   * @param text - Text to measure
   * @param maxWidthPx - Maximum width in pixels
   * @param startIndex - Starting index (default: 0)
   * @returns Number of characters that fit
   */
  charsThatFit(text: string, maxWidthPx: number, startIndex?: number): number
  
  /**
   * Detect the script type of a character.
   * @param char - Single character
   * @returns Script type
   */
  detectScript(char: string): ScriptType
  
  /**
   * Get the display profile.
   */
  getProfile(): DisplayProfile
}

type ScriptType = 
  | 'latin'
  | 'cjk'
  | 'hiragana'
  | 'katakana'
  | 'korean'
  | 'cyrillic'
  | 'numbers'
  | 'punctuation'
  | 'unsupported'
```

### 5.3 Implementation Notes

```typescript
class TextMeasurer {
  private profile: DisplayProfile
  private glyphCache: Map<string, number> = new Map()
  
  constructor(profile: DisplayProfile) {
    this.profile = profile
    // Pre-compute rendered widths for all known glyphs
    this.buildGlyphCache()
  }
  
  measureText(text: string): number {
    let totalWidth = 0
    for (const char of text) {
      totalWidth += this.measureChar(char)
    }
    return totalWidth
  }
  
  measureChar(char: string): number {
    // Check cache first
    const cached = this.glyphCache.get(char)
    if (cached !== undefined) return cached
    
    // Calculate and cache
    const glyphWidth = this.getGlyphWidth(char)
    const renderedWidth = this.profile.fontMetrics.renderFormula(glyphWidth)
    this.glyphCache.set(char, renderedWidth)
    return renderedWidth
  }
  
  getGlyphWidth(char: string): number {
    // Check explicit glyph map first (pixel-perfect)
    const explicit = this.profile.fontMetrics.glyphWidths.get(char)
    if (explicit !== undefined) return explicit
    
    // For uniform scripts, we don't need glyph width - measureChar handles it
    // This method is primarily for Latin characters in the map
    // Return a safe fallback for unmapped chars
    return 7  // Max glyph width for Latin ('m', 'w')
  }
  
  /**
   * Measure character width in rendered pixels.
   * 
   * IMPORTANT: This is PIXEL-PERFECT measurement, not averaging!
   * - Mapped characters: exact width from glyph map
   * - Uniform scripts (CJK, Korean, Cyrillic): verified uniform width
   * - Unmapped Latin: MAX width fallback (safe, never overflow)
   */
  measureChar(char: string): number {
    // 1. Check explicit glyph map (pixel-perfect for Latin)
    const glyphWidth = this.profile.fontMetrics.glyphWidths.get(char)
    if (glyphWidth !== undefined) {
      return this.profile.fontMetrics.renderFormula(glyphWidth)
    }
    
    // 2. Uniform-width scripts (verified monospace - NOT averages!)
    const script = this.detectScript(char)
    const uniform = this.profile.fontMetrics.uniformScripts
    
    switch (script) {
      case 'cjk':
        return uniform.cjk        // 18px - ALL CJK chars are exactly this
      case 'hiragana':
        return uniform.hiragana   // 18px - ALL Hiragana chars are exactly this
      case 'katakana':
        return uniform.katakana   // 18px - ALL Katakana chars are exactly this
      case 'korean':
        return uniform.korean     // 24px - ALL Korean chars are exactly this
      case 'cyrillic':
        return uniform.cyrillic   // 18px - ALL Cyrillic chars are exactly this
    }
    
    // 3. Unmapped Latin or unknown: use MAX width (safe fallback)
    // This guarantees we NEVER overflow - worst case is slight under-utilization
    return this.profile.fontMetrics.fallback.latinMaxWidth
  }
  
  detectScript(char: string): ScriptType {
    const code = char.charCodeAt(0)
    
    // CJK Unified Ideographs
    if (code >= 0x4E00 && code <= 0x9FFF) return 'cjk'
    if (code >= 0x3400 && code <= 0x4DBF) return 'cjk'  // Extension A
    
    // Japanese
    if (code >= 0x3040 && code <= 0x309F) return 'hiragana'
    if (code >= 0x30A0 && code <= 0x30FF) return 'katakana'
    
    // Korean
    if (code >= 0xAC00 && code <= 0xD7AF) return 'korean'
    if (code >= 0x1100 && code <= 0x11FF) return 'korean'  // Jamo
    
    // Cyrillic
    if (code >= 0x0400 && code <= 0x04FF) return 'cyrillic'
    
    // Numbers
    if (code >= 0x30 && code <= 0x39) return 'numbers'
    
    // Punctuation (basic)
    if (code >= 0x21 && code <= 0x2F) return 'punctuation'
    if (code >= 0x3A && code <= 0x40) return 'punctuation'
    
    // Unsupported scripts
    if (code >= 0x0600 && code <= 0x06FF) return 'unsupported'  // Arabic
    if (code >= 0x0590 && code <= 0x05FF) return 'unsupported'  // Hebrew
    if (code >= 0x0E00 && code <= 0x0E7F) return 'unsupported'  // Thai
    if (code >= 0x1F600 && code <= 0x1F64F) return 'unsupported' // Emoji
    
    // Default to Latin
    return 'latin'
  }
}
```

---

## 6. Layer 3: Text Wrapper

### 6.1 Purpose

Wrap text to fit within display constraints. Supports multiple break modes and respects explicit formatting (newlines).

### 6.2 Interface

```typescript
/**
 * Options for text wrapping.
 */
interface WrapOptions {
  /** Maximum width in pixels (defaults to profile's displayWidthPx) */
  maxWidthPx?: number
  
  /** Maximum number of lines (defaults to profile's maxLines) */
  maxLines?: number
  
  /** Maximum total bytes (defaults to profile's maxPayloadBytes) */
  maxBytes?: number
  
  /** 
   * Break mode:
   * - 'character': Break mid-word with hyphen for 100% utilization
   * - 'word': Break at word boundaries, hyphenate only if word > line
   * - 'strict-word': Break at word boundaries only, truncate long words
   */
  breakMode?: 'character' | 'word' | 'strict-word'
  
  /** Character to use for hyphenation (default: '-') */
  hyphenChar?: string
  
  /** Minimum characters before allowing hyphen break (default: 3) */
  minCharsBeforeHyphen?: number
  
  /** Whether to trim whitespace from line ends (default: true) */
  trimLines?: boolean
}

/**
 * Result of wrapping operation.
 */
interface WrapResult {
  /** Wrapped lines */
  lines: string[]
  
  /** Whether content was truncated to fit constraints */
  truncated: boolean
  
  /** Total pixel width of widest line */
  maxLineWidthPx: number
  
  /** Total byte size of all lines */
  totalBytes: number
  
  /** Per-line metadata */
  lineMetrics: LineMetrics[]
}

interface LineMetrics {
  text: string
  widthPx: number
  bytes: number
  utilizationPercent: number  // widthPx / maxWidthPx * 100
}

/**
 * Wraps text to fit display constraints.
 */
class TextWrapper {
  constructor(measurer: TextMeasurer, defaultOptions?: WrapOptions)
  
  /**
   * Wrap text to fit within constraints.
   * @param text - Text to wrap (may contain \n for explicit breaks)
   * @param options - Override default options
   * @returns Wrap result with lines and metadata
   */
  wrap(text: string, options?: WrapOptions): WrapResult
  
  /**
   * Simple wrap returning just lines (convenience method).
   * @param text - Text to wrap
   * @param options - Override default options
   * @returns Array of wrapped lines
   */
  wrapToLines(text: string, options?: WrapOptions): string[]
  
  /**
   * Check if text needs wrapping.
   * @param text - Text to check
   * @returns true if text exceeds single line
   */
  needsWrap(text: string): boolean
  
  /**
   * Get current options.
   */
  getOptions(): WrapOptions
}
```

### 6.3 Break Mode Details

#### Character Breaking (100% Utilization)

```typescript
// breakMode: 'character'

Input:  "The quick brown fox jumps over the lazy dog"
Output: [
  "The quick brown fox jumps over the la-",  // 100% utilized
  "zy dog"
]
```

**Algorithm:**
1. Fill line character by character
2. When next char would overflow:
   - Calculate space needed for hyphen
   - Remove characters until hyphen fits
   - Add hyphen, start new line with remainder
3. Skip hyphen for:
   - Breaking at spaces
   - CJK characters (can break anywhere without hyphen)
   - Line ending with punctuation

#### Word Breaking (Natural Breaks)

```typescript
// breakMode: 'word'

Input:  "The quick brown fox jumps over the lazy dog"
Output: [
  "The quick brown fox jumps over the",  // ~90% utilized
  "lazy dog"
]

// Long word that exceeds line width - falls back to hyphenation:
Input:  "This is supercalifragilisticexpialidocious"
Output: [
  "This is supercalifragilisticexpiali-",
  "docious"
]
```

**Algorithm:**
1. Split into words
2. Add words to line while they fit
3. When word doesn't fit:
   - If line has content, start new line
   - If single word exceeds line, hyphenate it
4. Continue until done

#### Strict Word Breaking (No Hyphenation)

```typescript
// breakMode: 'strict-word'

Input:  "This is supercalifragilisticexpialidocious"
Output: [
  "This is",
  "supercalifragilisticexpialidocious"  // Overflows! ⚠️
]
```

**Use case:** When hyphenation would look wrong (proper nouns, code, etc.)

### 6.4 Hyphen Math (Critical!)

The hyphen character itself has a pixel width that must be accounted for:

```
G1 Hyphen: glyph=4px → rendered=10px

Wrong approach:
┌─────────────────────────────────────────────────┐
│ The quick brown fox jumps over the lazy dog     │ 576px
└─────────────────────────────────────────────────┘
                                              ↑
                                        570px, 6px left
                                        
Add hyphen (10px) → 580px → OVERFLOW!

Correct approach:
┌─────────────────────────────────────────────────┐
│ The quick brown fox jumps over the lazy do-     │ 568px ✓
└─────────────────────────────────────────────────┘
                                              ↑
                                        558px text + 10px hyphen = 568px
```

**Algorithm for hyphen-aware breaking:**

```typescript
function breakWithHyphen(
  line: string, 
  lineWidth: number, 
  maxWidth: number,
  hyphenWidth: number
): { line: string; remainder: string } {
  
  let adjustedLine = line
  let adjustedWidth = lineWidth
  let remainder = ''
  
  // Remove characters until hyphen fits
  while (adjustedWidth + hyphenWidth > maxWidth && adjustedLine.length > 0) {
    const lastChar = adjustedLine[adjustedLine.length - 1]
    const lastCharWidth = measurer.measureChar(lastChar)
    
    adjustedLine = adjustedLine.slice(0, -1)
    adjustedWidth -= lastCharWidth
    remainder = lastChar + remainder
  }
  
  // Add hyphen (unless line ends with space or is empty)
  if (adjustedLine.length > 0 && !adjustedLine.endsWith(' ')) {
    adjustedLine += hyphenChar
  }
  
  return { line: adjustedLine, remainder }
}
```

---

## 7. Layer 4: Display Helpers

### 7.1 Purpose

Optional convenience utilities for common display operations. These build on top of TextWrapper for specific use cases.

### 7.2 Interface

```typescript
/**
 * Optional helper utilities for display operations.
 */
class DisplayHelpers {
  constructor(measurer: TextMeasurer, wrapper: TextWrapper)
  
  /**
   * Truncate lines array to max count, keeping most recent.
   * @param lines - Array of lines
   * @param maxLines - Maximum lines to keep
   * @param fromEnd - If true, keep last N lines; if false, keep first N
   * @returns Truncated lines array
   */
  truncateToLines(lines: string[], maxLines: number, fromEnd?: boolean): string[]
  
  /**
   * Estimate how many lines text will need without fully wrapping.
   * @param text - Text to estimate
   * @returns Estimated line count
   */
  estimateLineCount(text: string): number
  
  /**
   * Wrap and truncate text to fit screen in one call.
   * @param text - Text to fit
   * @param options - Wrap options
   * @returns Lines that fit on screen
   */
  fitToScreen(text: string, options?: WrapOptions): string[]
  
  /**
   * Calculate UTF-8 byte size of text.
   * @param text - Text to measure
   * @returns Byte size
   */
  calculateByteSize(text: string): number
  
  /**
   * Check if text exceeds byte limit.
   * @param text - Text to check
   * @param maxBytes - Optional override (defaults to profile)
   * @returns true if exceeds limit
   */
  exceedsByteLimit(text: string, maxBytes?: number): boolean
  
  /**
   * Split text into BLE-safe chunks.
   * @param text - Text to chunk
   * @param chunkSize - Optional override (defaults to profile)
   * @returns Array of chunks
   */
  splitIntoChunks(text: string, chunkSize?: number): string[]
}
```

---

## 8. Script & Language Support

### 8.1 Supported Scripts

| Script | Status | Width Strategy | Pixel Width | Max Chars/Line (G1) |
|--------|--------|----------------|-------------|---------------------|
| **Latin** (a-z, A-Z) | ✅ Full | Per-char glyph map | 4-16px (exact) | 36-144 |
| **Numbers** (0-9) | ✅ Full | Per-char glyph map | 6-12px (exact) | 48-96 |
| **Punctuation** | ✅ Full | Per-char glyph map | 4-16px (exact) | 36-144 |
| **Chinese** (汉字) | ✅ Full | Uniform (verified) | 18px (all chars) | 32 |
| **Japanese Kanji** | ✅ Full | Uniform (verified) | 18px (all chars) | 32 |
| **Japanese Hiragana** | ✅ Full | Uniform (verified) | 18px (all chars) | 32 |
| **Japanese Katakana** | ✅ Full | Uniform (verified) | 18px (all chars) | 32 |
| **Korean Hangul** | ✅ Full | Uniform (verified) | 24px (all chars) | 24 |
| **Cyrillic** | ✅ Full | Uniform (verified) | 18px (all chars) | 32 |
| **Arabic** | ❌ None | - | - | - |
| **Hebrew** | ❌ None | - | - | - |
| **Thai** | ❌ None | - | - | - |
| **Emoji** | ❌ None | - | - | - |

**Key Point:** We use PIXEL-PERFECT measurement, not averages!
- **Variable-width scripts (Latin):** Complete glyph map with exact width per character
- **Uniform-width scripts (CJK, Korean, Cyrillic):** Verified uniform width (all chars same)
- **Unmapped Latin fallback:** Use MAX width (16px) to guarantee no overflow

### 8.2 Script Detection

```typescript
// Unicode ranges for script detection
const SCRIPT_RANGES = {
  // CJK Unified Ideographs
  cjk: [
    [0x4E00, 0x9FFF],   // Main block
    [0x3400, 0x4DBF],   // Extension A
    [0x20000, 0x2A6DF], // Extension B
    [0xF900, 0xFAFF],   // Compatibility
  ],
  
  // Japanese
  hiragana: [[0x3040, 0x309F]],
  katakana: [[0x30A0, 0x30FF], [0x31F0, 0x31FF]],
  
  // Korean
  korean: [
    [0xAC00, 0xD7AF],   // Hangul Syllables
    [0x1100, 0x11FF],   // Hangul Jamo
    [0x3130, 0x318F],   // Compatibility Jamo
  ],
  
  // Cyrillic
  cyrillic: [[0x0400, 0x04FF]],
  
  // Unsupported (for filtering)
  arabic: [[0x0600, 0x06FF]],
  hebrew: [[0x0590, 0x05FF]],
  thai: [[0x0E00, 0x0E7F]],
  emoji: [
    [0x1F600, 0x1F64F],  // Emoticons
    [0x1F300, 0x1F5FF],  // Misc Symbols
    [0x1F680, 0x1F6FF],  // Transport
    [0x2600, 0x26FF],    // Misc Symbols
  ],
}
```

### 8.3 CJK-Specific Behavior

CJK languages have different breaking rules:

1. **No hyphenation needed** - CJK can break between any characters
2. **No spaces between words** - Text is continuous
3. **Punctuation rules** - Some chars shouldn't start/end lines

```typescript
// CJK can break anywhere without hyphen
if (isCJKCharacter(lastChar) || isCJKCharacter(nextChar)) {
  // Break without adding hyphen
  return { line: currentLine, remainder: '' }
}
```

### 8.4 Byte Size Considerations

Different scripts have different UTF-8 byte sizes:

| Script | Bytes/Char | 5-Line Limit (390 bytes) |
|--------|------------|--------------------------|
| Latin | 1 byte | 390 chars |
| Cyrillic | 2 bytes | 195 chars |
| CJK | 3 bytes | 130 chars |
| Korean | 3 bytes | 130 chars |

**Safe limits for G1:**
- Chinese/Japanese: 26 chars × 5 lines = 130 chars = 390 bytes ✓
- Korean: 22 chars × 5 lines = 110 chars = 330 bytes ✓

---

## 9. Use Cases & Code Examples

### 9.1 Captions App (Internal)

```typescript
import { 
  TextMeasurer, 
  TextWrapper, 
  DisplayHelpers,
  G1_PROFILE 
} from '@mentra/sdk/display-utils'

/**
 * Captions-specific display manager.
 * Uses SDK utilities but adds app-specific logic.
 */
class CaptionsDisplayManager {
  private measurer: TextMeasurer
  private wrapper: TextWrapper
  private helpers: DisplayHelpers
  private profile: DisplayProfile
  
  // App-specific state (NOT in SDK)
  private history: Array<{ speaker: string; text: string }> = []
  private maxHistory = 30
  private lastSpeaker: string | null = null
  
  constructor(profile: DisplayProfile = G1_PROFILE) {
    this.profile = profile
    this.measurer = new TextMeasurer(profile)
    this.wrapper = new TextWrapper(this.measurer, {
      breakMode: 'character',  // 100% utilization
      hyphenChar: '-',
      minCharsBeforeHyphen: 3,
    })
    this.helpers = new DisplayHelpers(this.measurer, this.wrapper)
  }
  
  /**
   * Process incoming transcription.
   * @param text - Transcription text
   * @param speaker - Speaker ID (e.g., "1", "2")
   * @param isFinal - Whether this is final or interim
   * @returns Lines to display on glasses
   */
  processTranscription(text: string, speaker: string, isFinal: boolean): string[] {
    // Update history (app-specific)
    if (isFinal) {
      this.history.push({ speaker, text })
      if (this.history.length > this.maxHistory) {
        this.history.shift()
      }
    }
    
    // Build display text with speaker labels (app-specific)
    const displayText = this.buildDisplayText(text, speaker, isFinal)
    
    // Use SDK to wrap (generic)
    const result = this.wrapper.wrap(displayText, {
      maxWidthPx: this.profile.displayWidthPx,
      maxLines: this.profile.maxLines,
      maxBytes: this.profile.maxPayloadBytes,
    })
    
    // Return lines, keeping most recent if truncated
    return result.lines.slice(-this.profile.maxLines)
  }
  
  /**
   * Build display text with speaker labels.
   * THIS IS APP-SPECIFIC - not in SDK!
   */
  private buildDisplayText(
    currentText: string, 
    currentSpeaker: string, 
    isFinal: boolean
  ): string {
    const parts: string[] = []
    let prevSpeaker: string | null = null
    
    // Build from recent history
    for (const entry of this.history.slice(-10)) {
      const needsLabel = entry.speaker !== prevSpeaker
      
      if (needsLabel) {
        // Speaker change - add newline (except first)
        if (parts.length > 0) {
          parts.push('\n')
        }
        parts.push(`[${entry.speaker}]: ${entry.text}`)
      } else {
        // Same speaker - continue with space
        parts.push(` ${entry.text}`)
      }
      
      prevSpeaker = entry.speaker
    }
    
    // Add current interim
    if (!isFinal && currentText) {
      const needsLabel = currentSpeaker !== prevSpeaker
      if (needsLabel) {
        if (parts.length > 0) parts.push('\n')
        parts.push(`[${currentSpeaker}]: ${currentText}`)
      } else {
        parts.push(` ${currentText}`)
      }
    }
    
    return parts.join('')
  }
}

// Usage:
const captions = new CaptionsDisplayManager()

const lines = captions.processTranscription(
  "Hello, how are you today?",
  "1",
  true
)
// lines = ["[1]: Hello, how are you today?"]

const lines2 = captions.processTranscription(
  "I'm doing great, thanks for asking!",
  "2", 
  true
)
// lines2 = [
//   "[1]: Hello, how are you today?",
//   "[2]: I'm doing great, thanks for asking!"
// ]
```

### 9.2 Teleprompter App (Third-Party Developer)

```typescript
import { 
  TextMeasurer, 
  TextWrapper,
  G1_PROFILE 
} from '@mentra/sdk/display-utils'

/**
 * Simple teleprompter - shows text one screen at a time.
 */
class TeleprompterApp {
  private wrapper: TextWrapper
  private pages: string[][] = []
  private currentPage = 0
  
  constructor() {
    const measurer = new TextMeasurer(G1_PROFILE)
    this.wrapper = new TextWrapper(measurer, {
      breakMode: 'word',  // Natural reading, not max utilization
      maxLines: G1_PROFILE.maxLines,
    })
  }
  
  /**
   * Load script and paginate.
   */
  loadScript(script: string): void {
    const result = this.wrapper.wrap(script)
    
    // Split into pages of maxLines each
    this.pages = []
    const maxLines = G1_PROFILE.maxLines
    
    for (let i = 0; i < result.lines.length; i += maxLines) {
      this.pages.push(result.lines.slice(i, i + maxLines))
    }
    
    this.currentPage = 0
  }
  
  /**
   * Get current page lines.
   */
  getCurrentPage(): string[] {
    return this.pages[this.currentPage] || []
  }
  
  /**
   * Advance to next page.
   */
  nextPage(): string[] {
    if (this.currentPage < this.pages.length - 1) {
      this.currentPage++
    }
    return this.getCurrentPage()
  }
  
  /**
   * Go to previous page.
   */
  prevPage(): string[] {
    if (this.currentPage > 0) {
      this.currentPage--
    }
    return this.getCurrentPage()
  }
}
```

### 9.3 Notification App (Third-Party Developer)

```typescript
import { 
  TextMeasurer, 
  TextWrapper,
  DisplayHelpers,
  G1_PROFILE 
} from '@mentra/sdk/display-utils'

/**
 * Shows notifications with titles and body text.
 */
class NotificationApp {
  private measurer: TextMeasurer
  private wrapper: TextWrapper
  private helpers: DisplayHelpers
  
  constructor() {
    this.measurer = new TextMeasurer(G1_PROFILE)
    this.wrapper = new TextWrapper(this.measurer)
    this.helpers = new DisplayHelpers(this.measurer, this.wrapper)
  }
  
  /**
   * Format a notification for display.
   * @param title - Notification title (will be on first line)
   * @param body - Notification body
   * @returns Lines to display
   */
  formatNotification(title: string, body: string): string[] {
    const maxWidth = G1_PROFILE.displayWidthPx
    const maxLines = G1_PROFILE.maxLines
    
    // Title gets first line (truncated if needed)
    const titleWidth = this.measurer.measureText(title)
    let displayTitle = title
    
    if (titleWidth > maxWidth) {
      // Truncate with ellipsis
      let truncated = ''
      let width = 0
      const ellipsisWidth = this.measurer.measureText('...')
      
      for (const char of title) {
        const charWidth = this.measurer.measureChar(char)
        if (width + charWidth + ellipsisWidth > maxWidth) break
        truncated += char
        width += charWidth
      }
      displayTitle = truncated + '...'
    }
    
    // Body gets remaining lines
    const bodyResult = this.wrapper.wrap(body, {
      maxLines: maxLines - 1,  // Reserve 1 for title
    })
    
    return [displayTitle, ...bodyResult.lines]
  }
}

// Usage:
const notifications = new NotificationApp()

const lines = notifications.formatNotification(
  "New Message from John",
  "Hey! Are you free for lunch today? I was thinking we could try that new place downtown."
)
// lines = [
//   "New Message from John",
//   "Hey! Are you free for lunch today? I",
//   "was thinking we could try that new",
//   "place downtown."
// ]
```

### 9.4 Bullet List (Third-Party Developer)

```typescript
import { TextMeasurer, TextWrapper, G1_PROFILE } from '@mentra/sdk/display-utils'

/**
 * Display bulleted lists.
 */
class BulletListApp {
  private measurer: TextMeasurer
  private wrapper: TextWrapper
  
  constructor() {
    this.measurer = new TextMeasurer(G1_PROFILE)
    this.wrapper = new TextWrapper(this.measurer)
  }
  
  /**
   * Format items as bullet list.
   */
  formatBulletList(items: string[]): string[] {
    const bullet = '• '
    const bulletWidth = this.measurer.measureText(bullet)
    const maxWidth = G1_PROFILE.displayWidthPx
    const contentWidth = maxWidth - bulletWidth
    
    const lines: string[] = []
    
    for (const item of items) {
      // Wrap item text to fit after bullet
      const itemResult = this.wrapper.wrap(item, {
        maxWidthPx: contentWidth,
      })
      
      // First line gets bullet, rest get indent
      const indent = '  '  // Same width as bullet
      
      itemResult.lines.forEach((line, i) => {
        if (i === 0) {
          lines.push(bullet + line)
        } else {
          lines.push(indent + line)
        }
      })
    }
    
    return lines.slice(0, G1_PROFILE.maxLines)
  }
}

// Usage:
const bullets = new BulletListApp()

const lines = bullets.formatBulletList([
  "First item",
  "Second item with longer text that wraps",
  "Third item"
])
// lines = [
//   "• First item",
//   "• Second item with longer text that",
//   "  wraps",
//   "• Third item"
// ]
```

---

## 10. Edge Cases & Nuances

### 10.1 Hyphen Width Accounting

**Problem:** When breaking mid-word, the hyphen takes space that must be pre-calculated.

```
Line at 570px, max is 576px
Remaining space: 6px
Hyphen width: 10px

WRONG: Add next char, then hyphen → overflow!
RIGHT: Reserve hyphen space, break earlier
```

**Solution:** Always check `currentWidth + hyphenWidth <= maxWidth` before breaking.

### 10.2 Very Narrow Characters

**Problem:** If breaking requires removing characters to fit hyphen, narrow chars (l, i) may require removing multiple.

```
Line: "illllllll" at 570px
Need to remove 4px to fit 10px hyphen
'l' = 4px each
Removing one 'l' gives 566px + 10px = 576px ✓

But if all chars are 4px and we need 10px space:
May need to remove 2-3 chars!
```

**Solution:** Loop removing chars until `currentWidth + hyphenWidth <= maxWidth`.

### 10.3 Single Character Lines

**Problem:** What if first character exceeds line width? (Shouldn't happen with reasonable fonts)

```
maxWidth = 10px
Character 'W' = 16px
```

**Solution:** Force the character onto line anyway (overflow is better than infinite loop).

### 10.4 Empty Input

**Problem:** Empty string or whitespace-only input.

**Solution:** Return `['']` (single empty line) to avoid null/undefined issues.

### 10.5 Consecutive Spaces

**Problem:** Multiple spaces in input.

```
Input: "Hello    world"
```

**Solution:** Preserve internal spaces but trim line ends.

### 10.6 Newline Handling

**Problem:** Input may contain `\n`, `\r\n`, or `\r`.

**Solution:** Normalize all to `\n`, split on `\n`, wrap each paragraph.

### 10.7 Mixed Scripts in Same Line

**Problem:** Latin + CJK in same line has variable character widths.

```
"Hello 世界" - 5 Latin chars + 2 CJK chars
```

**Solution:** Measure each character individually, don't assume uniform width.

### 10.8 Breaking Near CJK

**Problem:** When breaking between Latin and CJK, should hyphen be used?

```
"Hello世界" - break between 'o' and '世'?
```

**Solution:** No hyphen needed when next char is CJK (CJK breaks naturally).

### 10.9 Speaker Label Breaking

**Problem:** Should `[1]:` ever be separated from following text?

```
BAD:                      GOOD:
[1]:                      [1]: Hello there
Hello there
```

**Solution:** Apps should ensure label + first word fit on same line, or put on separate line intentionally.

### 10.10 Byte Limit vs Line Limit

**Problem:** Text may fit in 5 lines but exceed 390 bytes (CJK).

```
Chinese text: 32 chars × 5 lines = 160 chars = 480 bytes > 390!
```

**Solution:** Check both constraints; truncate at whichever hits first.

---

## 11. Migration Plan

### 11.1 Current Code Location

```
cloud/packages/apps/line-width/src/app/utils/
├── text-wrapping/
│   ├── TranscriptProcessor.ts    → To be replaced
│   ├── visualWidth.ts            → To be replaced
│   ├── wrapText.ts               → To be replaced
│   └── convertLineWidth.ts       → To be removed
└── index.ts
```

### 11.2 New Package Structure

```
packages/
├── display-utils/                 # NEW PACKAGE
│   ├── src/
│   │   ├── profiles/
│   │   │   ├── index.ts
│   │   │   ├── types.ts          # DisplayProfile, FontMetrics interfaces
│   │   │   └── g1.ts             # G1_PROFILE constant
│   │   ├── measurer/
│   │   │   ├── index.ts
│   │   │   ├── TextMeasurer.ts
│   │   │   └── scriptDetection.ts
│   │   ├── wrapper/
│   │   │   ├── index.ts
│   │   │   ├── TextWrapper.ts
│   │   │   └── breakStrategies.ts
│   │   ├── helpers/
│   │   │   ├── index.ts
│   │   │   └── DisplayHelpers.ts
│   │   └── index.ts              # Public exports
│   ├── test/
│   │   ├── measurer.test.ts
│   │   ├── wrapper.test.ts
│   │   └── integration.test.ts
│   ├── package.json
│   └── tsconfig.json
│
├── sdk/                           # UPDATE to re-export display-utils
│   └── src/
│       └── display-utils.ts       # Re-exports from @mentra/display-utils
│
└── apps/
    ├── captions/                  # UPDATE to use new utils
    │   └── src/app/
    │       └── CaptionsFormatter.ts  # App-specific, uses display-utils
    │
    └── line-width/                # KEEP as test/debug tool
        └── src/app/utils/         # Keep old code as reference
```

### 11.3 Migration Steps

1. **Create display-utils package** with new clean implementation
2. **Add to SDK** as re-export
3. **Build CaptionsFormatter** using new utils (app-specific layer)
4. **Update captions app** to use CaptionsFormatter
5. **Keep line-width** as debug tool, optionally update to use new utils
6. **Deprecate old code** but keep as reference

### 11.4 Backwards Compatibility

- Old `TranscriptProcessor` API can be shimmed using new utils
- Existing apps continue working during migration
- New apps use new utils directly

---

## 12. Future Considerations

### 12.1 New Glasses Support

When new glasses are released:

1. Create new `DisplayProfile` with hardware specs
2. Test font rendering, measure character widths
3. Add to profiles library
4. All existing apps work automatically!

```typescript
// future: Add new glasses
import { GLASSES_X1_PROFILE } from '@mentra/sdk/display-utils/profiles'

const measurer = new TextMeasurer(GLASSES_X1_PROFILE)
// Everything else stays the same
```

### 12.2 Dynamic Font Support

If future glasses support multiple fonts:

```typescript
interface DisplayProfile {
  // ... existing ...
  fonts: {
    default: FontMetrics
    bold?: FontMetrics
    monospace?: FontMetrics
  }
}
```

### 12.3 RTL Language Support

If future glasses support Arabic/Hebrew:

1. Add RTL script detection
2. Add `direction: 'ltr' | 'rtl'` to profile
3. Wrapper handles RTL breaking rules

### 12.4 Rich Text Support

If future glasses support formatting:

```typescript
interface RichTextSegment {
  text: string
  style?: 'bold' | 'italic' | 'underline'
  color?: string
}

wrapper.wrapRich(segments: RichTextSegment[]): RichWrapResult
```

### 12.5 Variable Font Sizes

If future glasses support font scaling:

```typescript
interface DisplayProfile {
  // ... existing ...
  fontSizes: {
    small: FontMetrics
    medium: FontMetrics  
    large: FontMetrics
  }
}
```

---

## 13. References

### 13.1 Related Specs

- [Line Width Debug Tool Spec](../line-width-debug-tool/line-width-spec.md)
- [Line Width Optimization Spec](../line-width-optimization/line-width-spec.md)

### 13.2 Source Code References

- `G1Text.kt` - Android text width calculation
- `G1FontLoaderKt` - G1 glyph width data
- `TranscriptProcessor.ts` - Current (legacy) wrapping logic
- `visualWidth.ts` - Current (legacy) width calculation

### 13.3 Hardware Documentation

- Even Realities G1 display: 576px width, 5 lines max
- BLE constraints: 176 byte chunks, 390 byte safe payload

---

## Appendix A: G1 Complete Glyph Width Table

```typescript
// All known G1 glyph widths (from G1FontLoaderKt)
// Rendered width = (glyphWidth + 1) * 2

const G1_GLYPH_WIDTHS = {
  // Punctuation & Symbols
  ' ': 2, '!': 1, '"': 2, '#': 6, '$': 5, '%': 6, '&': 7, "'": 1,
  '(': 2, ')': 2, '*': 3, '+': 4, ',': 1, '-': 4, '.': 1, '/': 3,
  
  // Numbers
  '0': 5, '1': 3, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5, '7': 5, '8': 5, '9': 5,
  
  // More punctuation
  ':': 1, ';': 1, '<': 4, '=': 4, '>': 4, '?': 5, '@': 7,
  
  // Uppercase
  'A': 6, 'B': 5, 'C': 5, 'D': 5, 'E': 4, 'F': 4, 'G': 5, 'H': 5,
  'I': 2, 'J': 3, 'K': 5, 'L': 4, 'M': 7, 'N': 5, 'O': 5, 'P': 5,
  'Q': 5, 'R': 5, 'S': 5, 'T': 5, 'U': 5, 'V': 6, 'W': 7, 'X': 6,
  'Y': 6, 'Z': 5,
  
  // Brackets & special
  '[': 2, '\\': 3, ']': 2, '^': 4, '_': 3, '`': 2,
  
  // Lowercase
  'a': 5, 'b': 4, 'c': 4, 'd': 4, 'e': 4, 'f': 4, 'g': 4, 'h': 4,
  'i': 1, 'j': 2, 'k': 4, 'l': 1, 'm': 7, 'n': 4, 'o': 4, 'p': 4,
  'q': 4, 'r': 3, 's': 4, 't': 3, 'u': 5, 'v': 5, 'w': 7, 'x': 5,
  'y': 5, 'z': 4,
  
  // More special
  '{': 3, '|': 1, '}': 3, '~': 7,
}
```

---

## Appendix B: Measurement Strategy Summary

### Latin Characters (Per-Character Glyph Map)

Each Latin character has an exact glyph width in the map. Examples:

| Character | Glyph Width | Rendered Width | Formula |
|-----------|-------------|----------------|---------|
| `l`, `i` | 1px | 4px | (1+1)×2 |
| `a`, `e` | 5px | 12px | (5+1)×2 |
| `m`, `w` | 7px | 16px | (7+1)×2 |
| `-` (hyphen) | 4px | **10px** | (4+1)×2 |
| ` ` (space) | 2px | **6px** | (2+1)×2 |

**Note:** The "average" Latin character is ~12px, but we NEVER use averages for calculation. Each character is measured exactly from the glyph map.

**Fallback:** Unknown Latin characters use MAX width (16px) to guarantee no overflow.

### Uniform-Width Scripts (Verified Monospace)

These scripts render ALL characters at the exact same width:

| Script | Width (ALL chars) | Max/Line (G1 576px) |
|--------|-------------------|---------------------|
| CJK (Chinese, Japanese Kanji) | 18px | 32 |
| Japanese Hiragana | 18px | 32 |
| Japanese Katakana | 18px | 32 |
| Korean Hangul | 24px | 24 |
| Cyrillic | 18px | 32 |

**These are NOT averages** - every character in these scripts renders at exactly this width on G1 hardware.

### Why This Approach?

1. **Pixel-perfect for mapped chars** - Exact width from glyph map
2. **Pixel-perfect for uniform scripts** - Verified uniform width
3. **Safe fallback** - MAX width guarantees no overflow
4. **Worst case** - Slight under-utilization (safe) vs overflow (broken)