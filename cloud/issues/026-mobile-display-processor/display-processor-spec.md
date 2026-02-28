# Mobile Display Processor Spec

## Overview

Consolidate text wrapping/formatting logic into a single React Native DisplayProcessor that uses the SDK's `display-utils` library, removing duplicate wrapping logic from native SGC layers.

## Problem

### 1. Duplicated Wrapping Logic

Text wrapping exists in multiple places with different implementations:

| Location                       | Language   | Logic                                   |
| ------------------------------ | ---------- | --------------------------------------- |
| `@mentra/sdk/display-utils`    | TypeScript | Pixel-accurate glyph widths, G1_PROFILE |
| `SGCManager` (Android)         | Kotlin     | Character count based (~44 chars)       |
| `SGCManager` (iOS)             | Swift      | Character count based (~44 chars)       |
| `TranscriptProcessor` (mobile) | TypeScript | Character count based (maxCharsPerLine) |

### 2. Inconsistent Results

Cloud apps using `display-utils`:

```
"The quick brown fox jumps over the la-"  // Pixel-accurate, 100% utilization
"zy dog"
```

Native SGC wrapping:

```
"The quick brown fox jumps over the"      // Word boundary, ~70% utilization
"lazy dog"
```

### 3. Preview Mismatch

`GlassesDisplayMirror` shows pre-wrapped lines from cloud but native SGC may re-wrap them differently, so preview doesn't match actual glasses display.

### 4. Double Wrapping

When cloud sends pre-wrapped text with `\n`, native SGC may add MORE line breaks if lines exceed its character limit, causing:

- Total lines > 5 (hard display limit)
- Content hidden from user
- App appears "stuck"

## Current Flow

```
Cloud App
    ↓ (display-utils wraps text)
display_event { text: "line1\nline2\nline3" }
    ↓ (WebSocket)
Mobile (SocketComms)
    ↓ (passes through)
Native SGC
    ↓ (may re-wrap!)
Glasses Display
```

## Proposed Flow

```
Cloud App
    ↓ (display-utils wraps text)
display_event { text: "line1\nline2\nline3" }
    ↓ (WebSocket)
Mobile (SocketComms)
    ↓
DisplayProcessor (display-utils)
    ↓ (validates/re-wraps for device profile)
Native SGC (render only, no wrapping)
    ↓
Glasses Display
```

## Goals

1. **Single source of truth** - All wrapping uses `display-utils` logic
2. **Preview accuracy** - `GlassesDisplayMirror` shows exactly what glasses will show
3. **Device-agnostic** - DisplayProcessor selects profile based on connected device
4. **Remove native wrapping** - SGC becomes a dumb renderer

## Non-Goals

- Changing the cloud SDK's display-utils implementation
- Supporting rich text / multiple fonts
- Dynamic font sizing
- RTL language support (future consideration)

## Constraints

### Technical

- React Native can't import Node.js-specific modules
- `display-utils` is pure TypeScript (no Node deps) ✅
- Native SGC code changes require app store updates
- Must support G1, Mach1, Mentra Live, simulated glasses

### Backwards Compatibility

- Old mobile clients may still have native wrapping
- Cloud apps already send pre-wrapped text
- Transition period where both may coexist

## DisplayProcessor Responsibilities

1. **Intercept display events** from WebSocket before sending to native
2. **Get device profile** based on connected glasses model
3. **Validate/format text** using display-utils with correct profile
4. **Send formatted text** to native SGC for rendering
5. **Update GlassesDisplayMirror** with same formatted output

## Code Sharing Strategy Options

### Option A: Direct Import

```typescript
// mobile/src/services/DisplayProcessor.ts
import { TextWrapper, G1_PROFILE } from "@mentra/sdk/display-utils";
```

**Pros**: No duplication, always in sync  
**Cons**: SDK has other deps mobile doesn't need, bundle size

### Option B: Separate Package

Move `display-utils` to `@mentra/display-utils` standalone package.

**Pros**: Clean separation, explicit dependency  
**Cons**: More packages to maintain, version sync issues

### Option C: Move to Types

Move core logic to `@mentra/types` which is already shared.

**Pros**: Already a shared package  
**Cons**: Types package shouldn't have runtime logic

### Option D: Copy Files

Copy `display-utils` source files to mobile.

**Pros**: Simple, no dependency issues  
**Cons**: Code duplication, drift risk

**Recommendation**: Start with Option A (direct import), measure bundle impact. If problematic, move to Option B.

## Device Profiles

DisplayProcessor needs to select correct profile:

| Device            | Profile      | Display Width       | Max Lines       |
| ----------------- | ------------ | ------------------- | --------------- |
| Even Realities G1 | G1_PROFILE   | 576px               | 5               |
| Vuzix Z100        | Z100_PROFILE | 390px               | 7               |
| Mentra Mach1      | Z100_PROFILE | 390px               | 7               |
| Mentra Nex        | NEX_PROFILE  | 576px (placeholder) | 5 (placeholder) |
| Mentra Live       | G1_PROFILE   | N/A (no display)    | N/A             |
| Simulated         | G1_PROFILE   | 576px               | 5               |

## Native SGC Changes

### Remove from Kotlin/Swift

- `wrapText()` / text wrapping functions
- Character limit constants (`MAX_CHARS_PER_LINE`)
- Word boundary detection logic

### Keep in Native

- `sendTextWall(text)` - Just renders the string as-is
- Line rendering (respecting `\n`)
- Font rendering
- Display clearing

## API Design

```typescript
interface DisplayProcessor {
  // Process display event before sending to native
  processDisplayEvent(event: DisplayEvent): ProcessedDisplayEvent;

  // Get current device profile
  getDeviceProfile(): DisplayProfile;

  // Set device profile when glasses connect
  setDeviceProfile(modelName: string): void;

  // Wrap text for current device
  wrapText(text: string, options?: WrapOptions): string[];
}

interface DisplayEvent {
  type: 'text_wall' | 'text_line' | 'reference_card' | 'double_text_wall' | ...;
  view: 'main' | 'dashboard';
  text?: string;
  title?: string;
  // ... other fields
}

interface ProcessedDisplayEvent extends DisplayEvent {
  // Text fields are guaranteed to be properly wrapped
  _processed: true;
  _profile: string;
}
```

## Migration Strategy

### Phase 1: Add DisplayProcessor (no native changes)

1. Create DisplayProcessor in React Native
2. Intercept display events, process with display-utils
3. Send to native (native still has wrapping, but text is pre-wrapped so no change)
4. Update GlassesDisplayMirror to use same processed output

### Phase 2: Remove Native Wrapping

1. Update native SGC to trust pre-wrapped text
2. Remove wrapping logic from Kotlin
3. Remove wrapping logic from Swift
4. Release new mobile app version

### Phase 3: Cleanup

1. Remove legacy wrapping code paths
2. Update tests
3. Document new architecture

## Success Metrics

- Preview matches glasses display 100% of time
- No double-wrapping issues reported
- Line utilization matches cloud apps (>95%)
- No content truncation due to line overflow

## Open Questions

1. **Bundle size impact of importing SDK in mobile?**
   - Need to measure before/after

2. **How to handle old mobile clients during transition?**
   - Native wrapping as fallback? Or force update?

3. **Should DisplayProcessor also handle bitmap_view?**
   - Currently only text layouts need wrapping

4. **Profile detection for new glasses models?**
   - Default to G1? Require explicit profile?

## References

- `cloud/packages/sdk/src/display-utils/` - SDK implementation
- `cloud/packages/apps/line-width/issues/display-utils/display-utils-spec.md` - Original spec
- `mobile/src/components/mirror/GlassesDisplayMirror.tsx` - Preview component
- `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/` - Native SGC code
