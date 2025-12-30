# Display Utils Library

## Status: 📋 Specification Phase

This issue tracks the design and implementation of a glasses-agnostic text measurement and wrapping library for smart glasses displays.

## Overview

The Display Utils library will provide pixel-accurate text measurement and wrapping utilities that work across different smart glasses hardware. It's designed to be:

- **Glasses-agnostic** - Support any glasses via configurable profiles
- **Pixel-accurate** - No abstract "visual units", real pixels only
- **SDK-ready** - Clean API for third-party developers
- **Reusable** - Used by SDK, cloud backend, and internal apps

## Problem Summary

The current text wrapping system has several issues:

1. **Hardcoded G1 assumptions** - Magic numbers and "visual units" tied to G1 specs
2. **Double wrapping** - Cloud and mobile both wrap, causing unpredictable results
3. **Low line utilization** - Word-wrap wastes ~44% of available display space
4. **Mixed concerns** - Wrapping, history, and formatting all tangled together
5. **App-specific logic in core** - Speaker labels baked into generic utilities

## Solution

A layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────┐
│  Layer 1: DisplayProfile                │  ← Hardware config (G1, future glasses)
├─────────────────────────────────────────┤
│  Layer 2: TextMeasurer                  │  ← Pixel-accurate measurement
├─────────────────────────────────────────┤
│  Layer 3: TextWrapper                   │  ← Generic wrapping with hyphenation
├─────────────────────────────────────────┤
│  Layer 4: DisplayHelpers                │  ← Optional conveniences
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│  App-Specific Layer (NOT in SDK)        │
│  - CaptionsFormatter (speaker labels)   │
│  - TeleprompterFormatter (pagination)   │
│  - NotificationFormatter (title/body)   │
└─────────────────────────────────────────┘
```

## Key Features

- **100% line utilization** via character-level hyphenation
- **Multiple break modes**: character, word, strict-word
- **Full script support**: Latin, CJK, Korean, Cyrillic
- **Byte-aware**: Respects BLE payload limits
- **Configurable profiles**: Easy to add new glasses

## Documents

- [**display-utils-spec.md**](./display-utils-spec.md) - Complete specification document

## Related Issues

- [Line Width Debug Tool](../line-width-debug-tool/) - Testing and validation tool
- [Line Width Optimization](../line-width-optimization/) - Original optimization spec

## Implementation Status

- [ ] Specification complete
- [ ] DisplayProfile interface
- [ ] G1 profile with verified glyph widths
- [ ] TextMeasurer implementation
- [ ] TextWrapper with hyphenation
- [ ] DisplayHelpers utilities
- [ ] Unit tests
- [ ] Integration with SDK
- [ ] Migration of captions app
- [ ] Documentation

## Usage Preview

```typescript
import { 
  TextMeasurer, 
  TextWrapper, 
  G1_PROFILE 
} from '@mentra/sdk/display-utils'

// Create measurer and wrapper
const measurer = new TextMeasurer(G1_PROFILE)
const wrapper = new TextWrapper(measurer, {
  breakMode: 'character',  // 100% utilization
})

// Wrap text
const result = wrapper.wrap("Hello, world! This is a long text that needs wrapping.")

// result.lines = [
//   "Hello, world! This is a long text th-",
//   "at needs wrapping."
// ]
```

## Adding New Glasses

```typescript
// Just create a new profile!
const NEW_GLASSES_PROFILE: DisplayProfile = {
  id: 'new-glasses-v1',
  displayWidthPx: 800,
  maxLines: 7,
  fontMetrics: { ... },
  // ...
}

// Everything else works automatically
const measurer = new TextMeasurer(NEW_GLASSES_PROFILE)
```

## Questions / Discussion

For questions or discussion about this spec, please comment on the related GitHub issue or reach out on Discord.