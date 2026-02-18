# @mentra/display-utils

Pixel-accurate text measurement and wrapping library for smart glasses displays. This package is shared between the cloud SDK and mobile app to ensure consistent text rendering across all platforms.

## Features

- **Pixel-perfect measurement** - Uses actual glyph widths from hardware fonts, not averages
- **Multiple break modes** - Character (with hyphen), word, and strict-word breaking
- **Full script support** - Latin, CJK, Korean, Cyrillic with verified uniform widths
- **Device profiles** - Pre-configured settings for different glasses hardware (G1, etc.)
- **Zero dependencies** - Pure TypeScript, works in Node.js, React Native, and browsers

## Installation

```bash
# From the monorepo root
bun install

# Or add as a dependency
bun add @mentra/display-utils
```

## Quick Start

```typescript
import { createG1Toolkit } from '@mentra/display-utils'

// Create a toolkit configured for G1 glasses
const { wrapper, measurer } = createG1Toolkit()

// Wrap text to fit the display
const result = wrapper.wrap("Hello, world! This is a long text that needs wrapping.")
console.log(result.lines)
// ["Hello, world! This is a long text th-", "at needs wrapping."]

// Measure text width in pixels
const width = measurer.measureText("Hello")
console.log(width) // 52 (pixels)
```

## API

### Factory Functions

#### `createG1Toolkit()`

Creates a complete display toolkit configured for Even Realities G1 glasses with character breaking mode.

```typescript
const { measurer, wrapper, helpers, profile } = createG1Toolkit()
```

#### `createDisplayToolkit(profile, options?)`

Creates a toolkit with a custom profile and options.

```typescript
import { createDisplayToolkit, G1_PROFILE } from '@mentra/display-utils'

const toolkit = createDisplayToolkit(G1_PROFILE, {
  breakMode: 'word',
  hyphenChar: '-',
  minCharsBeforeHyphen: 3,
})
```

### TextMeasurer

Measures text width in pixels based on a display profile.

```typescript
const measurer = new TextMeasurer(G1_PROFILE)

// Measure a string
const width = measurer.measureText("Hello, world!")

// Measure a single character
const charWidth = measurer.measureChar("A")

// Check if text fits
const fits = measurer.fitsInWidth("Hello", 100)

// Find how many characters fit
const count = measurer.charsThatFit("Hello, world!", 50)
```

### TextWrapper

Wraps text to fit display constraints.

```typescript
const wrapper = new TextWrapper(measurer, { breakMode: 'character' })

// Full wrap with metadata
const result = wrapper.wrap("Long text here...")
console.log(result.lines)        // Array of wrapped lines
console.log(result.truncated)    // Whether text was truncated
console.log(result.lineMetrics)  // Per-line width/byte info

// Simple wrap returning just lines
const lines = wrapper.wrapToLines("Long text here...")
```

#### Break Modes

- **`character`** - Break mid-word with hyphen for maximum line utilization (~100%)
- **`word`** - Break at word boundaries, hyphenate only if word exceeds line width
- **`strict-word`** - Break at word boundaries only, no hyphenation (may overflow)

### Display Profiles

Pre-configured profiles for different glasses hardware:

```typescript
import { G1_PROFILE, G1_PROFILE_LEGACY } from '@mentra/display-utils'

// G1_PROFILE - Standard Even Realities G1 profile
// - Display width: 576px
// - Max lines: 5
// - Max payload: 390 bytes

// G1_PROFILE_LEGACY - For older mobile clients with double-wrapping
// - Display width: 420px (reduced to prevent overflow)
```

### DisplayHelpers

Utility functions for common display operations:

```typescript
const helpers = new DisplayHelpers(measurer, wrapper)

// Truncate text with ellipsis
const truncated = helpers.truncate("Long text...", 100)

// Paginate content
const pages = helpers.paginate("Very long content...", { linesPerPage: 5 })

// Create chunks for streaming
const chunks = helpers.chunk("Content to stream...", { maxBytes: 176 })
```

### ScrollView

Manages scrollable content larger than the display:

```typescript
const scrollView = new ScrollView(measurer, wrapper)

scrollView.setContent("Very long scrollable text...")
scrollView.scrollDown()
scrollView.scrollUp()

const viewport = scrollView.getViewport()
console.log(viewport.lines)       // Currently visible lines
console.log(viewport.position)    // Current scroll position
console.log(viewport.canScrollUp) // Whether more content above
```

## Display Profile Structure

```typescript
interface DisplayProfile {
  id: string
  name: string
  displayWidthPx: number      // Display width in pixels
  maxLines: number            // Maximum lines on display
  maxPayloadBytes: number     // BLE payload limit
  bleChunkSize: number        // BLE chunk size for transmission
  
  fontMetrics: {
    glyphWidths: Map<string, number>  // Character -> glyph width
    renderFormula: (glyph: number) => number  // Glyph to rendered pixels
    uniformScripts: {
      cjk: number       // Width for CJK characters
      korean: number    // Width for Korean characters
      cyrillic: number  // Width for Cyrillic characters
      // ...
    }
    fallback: {
      latinMaxWidth: number  // Fallback for unmapped Latin chars
    }
  }
}
```

## Usage in Different Environments

### Cloud SDK

```typescript
// In @mentra/sdk, re-export from display-utils
export * from '@mentra/display-utils'
```

### React Native Mobile

```typescript
// In mobile app
import { createG1Toolkit, TextWrapper } from '@mentra/display-utils'

const { wrapper } = createG1Toolkit()
const lines = wrapper.wrapToLines(transcriptionText)
```

### Browser/Web

```typescript
// Works directly in browser environments
import { createG1Toolkit } from '@mentra/display-utils'
```

## Development

```bash
# Build the package
bun run build

# Type check
bun run typecheck

# Watch mode
bun run dev
```

## Architecture

```
src/
├── index.ts           # Main exports and factory functions
├── profiles/          # Device profiles (G1, etc.)
│   ├── g1.ts         # G1 glyph widths and config
│   ├── types.ts      # Profile type definitions
│   └── index.ts
├── measurer/          # Text measurement
│   ├── TextMeasurer.ts
│   ├── script-detection.ts  # CJK/Korean/Cyrillic detection
│   └── index.ts
├── wrapper/           # Text wrapping
│   ├── TextWrapper.ts
│   ├── types.ts
│   └── index.ts
└── helpers/           # Utility functions
    ├── DisplayHelpers.ts
    ├── ScrollView.ts
    └── index.ts
```

## License

MIT