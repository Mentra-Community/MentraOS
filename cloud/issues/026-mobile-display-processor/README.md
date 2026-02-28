# Issue 026: Mobile Display Processor

**Status**: In Progress 🔄  
**Priority**: Medium  
**Related**: @mentra/display-utils, GlassesDisplayMirror

## Problem

Text wrapping logic is duplicated and inconsistent across the codebase:

1. **Cloud SDK** (`@mentra/sdk/display-utils`) - Pixel-accurate wrapping with glyph widths
2. **Native SGC layer** (Kotlin/Swift) - Separate wrapping logic, different results
3. **Mobile preview** (`GlassesDisplayMirror`) - No wrapping, just displays what it receives

This causes:

- Preview doesn't match actual glasses display
- Double-wrapping when cloud and native both wrap
- Inconsistent line breaks between cloud apps and native rendering

## Documents

- **[display-processor-spec.md](./display-processor-spec.md)** - Problem, goals, constraints
- **[display-processor-architecture.md](./display-processor-architecture.md)** - Implementation details, data flow, integration points
- **[026a-head-up-dashboard-disabled-bug.md](./026a-head-up-dashboard-disabled-bug.md)** - Bug fix: head-up view not updating when dashboard disabled
- **[026b-double-text-wall-alignment.md](./026b-double-text-wall-alignment.md)** - Investigation: double_text_wall column alignment issues

## Quick Context

**Current**: Native SGC has its own wrapping logic → inconsistent with cloud display-utils  
**Proposed**: Add DisplayProcessor in React Native layer using same display-utils logic → single source of truth

## Key Insight

The SDK's `display-utils` is pure TypeScript with no Node.js dependencies:

- `TextMeasurer` - Glyph width lookups
- `TextWrapper` - Line breaking algorithms
- `G1_PROFILE`, `Z100_PROFILE`, `NEX_PROFILE` - Hardware-specific measurements

This is now a shared package `@mentra/display-utils` used by both SDK and mobile.

## Solution Implemented

```
Cloud App → display-utils → pre-wrapped lines → WebSocket
                                                    ↓
Mobile ← DisplayProcessor (display-utils) ← display_event
                    ↓
            Native SGC (render pre-wrapped text)
```

**All display events flow through DisplayProcessor** - both cloud events (via WebSocket) and local/offline events (via `handle_display_event`). There are no code paths that bypass the DisplayProcessor, so native SGC wrapping can be removed entirely without backwards compatibility concerns.

## Implementation Details

### Files Created/Modified

**New Package:**

- `cloud/packages/display-utils/` - Shared `@mentra/display-utils` package
  - `src/index.ts` - Main exports and factory functions
  - `src/profiles/g1.ts` - Even Realities G1 profile
  - `src/profiles/z100.ts` - Vuzix Z100 profile (placeholder values)
  - `src/profiles/nex.ts` - Mentra Nex profile (placeholder values)
  - `src/measurer/` - Text measurement with glyph widths
  - `src/wrapper/` - Text wrapping with multiple break modes
  - `src/helpers/` - Utility functions and ScrollView

**Mobile Files:**

- `mobile/src/services/display/DisplayProcessor.ts` - Main processor class
- `mobile/src/services/display/index.ts` - Service exports

**Modified Files:**

- `mobile/src/services/SocketComms.ts` - Uses DisplayProcessor to process display events before sending to native
- `mobile/src/bridge/MantleBridge.tsx` - Updates DisplayProcessor device model when glasses connect
- `mobile/package.json` - Added `@mentra/display-utils` dependency
- `mobile/tsconfig.json` - Added path mapping for `@mentra/display-utils`
- `mobile/babel.config.cts` - Added alias for `@mentra/display-utils`
- `mobile/metro.config.js` - Added watch folder for display-utils
- `cloud/packages/sdk/package.json` - Added `@mentra/display-utils` as dependency
- `cloud/packages/sdk/src/display-utils.ts` - Now re-exports from shared package
- `cloud/package.json` - Updated build scripts to include display-utils

### Code Sharing Strategy

**Decision**: Create shared `@mentra/display-utils` package (Option B from spec)

**Rationale**:

- Single source of truth - no code duplication
- Both SDK and mobile import from the same package
- Pure TypeScript with zero external dependencies
- Easy to maintain and version
- Clear ownership and separation of concerns

### DisplayProcessor API

```typescript
import {displayProcessor} from "@/services/display"

// When glasses connect (called from MantleBridge)
displayProcessor.setDeviceModel("Even Realities G1")

// Process display events (called from SocketComms)
const processed = displayProcessor.processDisplayEvent(rawEvent)

// Direct text wrapping
const lines = displayProcessor.wrapText("Hello world this is a long text")

// Measure text width
const widthPx = displayProcessor.measureText("Hello")
```

### Supported Layout Types

- ✅ `text_wall` - Full text wrapping with line breaks
- ✅ `text_line` - Same as text_wall
- ✅ `text_rows` - Array of rows, each wrapped independently
- ✅ `reference_card` - Title (1 line) + text (remaining lines)
- ✅ `double_text_wall` - Two columns with pixel-precise space alignment via ColumnComposer
- ✅ `bitmap_view` - Pass through (no text processing)

### Device Profile Support

| Device            | Profile        | Display Width | Max Lines | Status                                        |
| ----------------- | -------------- | ------------- | --------- | --------------------------------------------- |
| Even Realities G1 | `G1_PROFILE`   | 576px         | 5         | ✅ Full support                               |
| Vuzix Z100        | `Z100_PROFILE` | 390px         | 7         | ✅ Full support (Noto Sans metrics extracted) |
| Mentra Mach1      | `Z100_PROFILE` | 390px         | 7         | ✅ Full support (same hardware as Z100)       |
| Mentra Nex        | `NEX_PROFILE`  | 576px         | 5         | ⚠️ Placeholder (needs actual font metrics)    |
| Mentra Live       | `G1_PROFILE`   | N/A           | N/A       | ℹ️ No display, uses G1 as fallback            |
| Simulated         | `G1_PROFILE`   | 576px         | 5         | ✅ Full support                               |

### Device Model Normalization

The `DisplayProcessor.normalizeModelName()` function maps model strings to profiles:

| Input String                                | Maps To                      |
| ------------------------------------------- | ---------------------------- |
| `"Even Realities G1"`, `"g1"`               | `g1` → `G1_PROFILE`          |
| `"Vuzix Z100"`, `"z100"`, `"vuzix"`         | `z100` → `Z100_PROFILE`      |
| `"Mentra Mach1"`, `"mach1"`, `"mach 1"`     | `mach1` → `Z100_PROFILE`     |
| `"Mentra Nex"`, `"nex"`, `"mentra display"` | `nex` → `NEX_PROFILE`        |
| `"Mentra Live"`, `"mentra-live"`            | `mentra-live` → `G1_PROFILE` |
| `"Simulated Glasses"`, `"simulated"`        | `simulated` → `G1_PROFILE`   |

## Completed

### Phase 2: Native SGC Wrapping Removal ✅

Native wrapping logic has been removed/simplified. Text now comes pre-wrapped from DisplayProcessor.

**Android:**

- `G1.java` - `createTextWallChunks()` simplified to just call `chunkTextForTransmission()` without re-wrapping
- `G1Text.kt` - `splitIntoLines()` still exists for legacy `createDoubleTextWallChunks()` but is no longer used for text_wall

**iOS:**

- `G1Text.swift` - `createTextWallChunks()` simplified to just call `chunkTextForTransmission()` without re-wrapping
- `splitIntoLines()` still exists for legacy `createDoubleTextWallChunks()` but is no longer used for text_wall

**Additional fix:** Fixed `displayEvent()` in both iOS and Android to always call `sendCurrentState()` when view state changes. The previous conditional logic was causing display updates to be missed when looking up (head-up position).

### Phase 2.5: ColumnComposer for double_text_wall ✅

Added `ColumnComposer` class to `@mentra/display-utils` for pixel-precise column composition:

- `ColumnComposer.composeDoubleTextWall(left, right)` - wraps both columns and merges with space-padding
- `DisplayProcessor.processDoubleTextWall()` now uses ColumnComposer
- Outputs pre-composed text as `text_wall` layout type
- Native just chunks and sends - no column composition logic needed

**Files created:**

- `cloud/packages/display-utils/src/composer/ColumnComposer.ts`
- `cloud/packages/display-utils/src/composer/index.ts`

**Files modified:**

- `cloud/packages/display-utils/src/index.ts` - exports ColumnComposer
- `mobile/src/services/display/DisplayProcessor.ts` - uses ColumnComposer for double_text_wall
- `mobile/modules/core/ios/Source/utils/G1Text.swift` - simplified createTextWallChunks
- `mobile/modules/core/ios/Source/CoreManager.swift` - fixed displayEvent
- `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/G1.java` - simplified createTextWallChunks
- `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt` - fixed displayEvent

### Phase 3: Validation ✅

- App builds and runs successfully
- DisplayProcessor loads without errors
- Display events are processed through DisplayProcessor
- Fallback to raw events works if processing fails

### Phase 4: Z100 Profile Update ✅

Updated Z100 profile with real font metrics extracted from Noto Sans TTF:

- Extracted glyph widths from `NotoSans-Regular.ttf` at 21px using `extract-font-metrics.js`
- Updated `displayWidthPx` to 390px (empirically tested - SDK applies internal margins)
- Updated `maxLines` to 7
- Added real glyph widths for all ASCII characters
- Space width: 5px, Hyphen width: 7px

**Note**: The Vuzix Ultralite SDK handles text rendering internally and applies its own margins/padding. The usable text width (390px) is significantly less than the physical 640px resolution. Empirical testing shows ~42 characters of mixed text fits on one line before the SDK wraps.

### Phase 5: Hyphen-Free Word Breaking ✅

Added new break mode `character-no-hyphen` that breaks words mid-word without adding a hyphen character.

**Problem**: When text wraps mid-word, the hyphen (`-`) was being added at the break point. Users reported this was confusing and unnecessary.

**Solution**: Added a new break mode that breaks cleanly without adding any character.

**Files modified:**

- `cloud/packages/display-utils/src/wrapper/types.ts` - Added `character-no-hyphen` to `BreakMode` type, changed default
- `cloud/packages/display-utils/src/wrapper/TextWrapper.ts` - Implemented `wrapCharacterNoHyphenMode()`
- `cloud/packages/display-utils/src/index.ts` - Updated all toolkit factory functions
- `cloud/packages/display-utils/src/composer/ColumnComposer.ts` - Updated default break mode
- `mobile/src/services/display/DisplayProcessor.ts` - Updated default break mode

**Break modes available:**

- `character` - Break mid-word with hyphen (old default)
- `character-no-hyphen` - Break mid-word without hyphen (new default) ✅
- `word` - Break at word boundaries, hyphenate only if word > line width
- `strict-word` - Break at word boundaries only, no hyphenation

### Phase 6: Placeholder Replacement Migration ✅

Moved placeholder replacement (`$GBATT$`, `$TIME12$`, `$DATE$`, etc.) from native layer to React Native DisplayProcessor.

**Problem**: Native was replacing placeholders AFTER DisplayProcessor had already wrapped text. This caused incorrect measurements because placeholder strings like `$GBATT$` (7 chars) have different widths than their resolved values like `85%` (3 chars).

**Solution**: Replace placeholders in DisplayProcessor BEFORE wrapping, so measurements are accurate.

**Files modified:**

- `mobile/src/services/display/DisplayProcessor.ts` - Added `replacePlaceholders()` function and `getPlaceholderValues()`

**Placeholders supported:**
| Placeholder | Example Value | Description |
|-------------|---------------|-------------|
| `$TIME12$` | `2:30 PM` | 12-hour time format |
| `$TIME24$` | `14:30` | 24-hour time format |
| `$DATE$` | `1/22` | Month/day format |
| `$GBATT$` | `85%` or ``| Glasses battery (empty if unknown) |
| `$CONNECTION_STATUS$` | `Connected` or`` | Connection status |
| `$no_datetime$` | `1/22, 2:30 PM` | Combined date and time |

**Note**: Native code (CoreManager.kt/CoreManager.swift) still has `parsePlaceholders()` but it's now a no-op for text that goes through DisplayProcessor since placeholders are already replaced.

### Phase 7: Double Text Wall Alignment Investigation 🔄

**Status**: Under Investigation

**Problem**: Dashboard view showing misaligned columns in `double_text_wall` layout. The right column content appears "indented" when it wraps to multiple lines.

**Investigation findings:**

1. **Algorithm is correct**: The `ColumnComposer` algorithm matches the native iOS/Android implementation exactly. Each line calculates the correct number of spaces to position the right column at `rightColumnStartPx` (316px on G1).

2. **Expected behavior**: When the left column has fewer lines of content than the right column, the continuation lines of the right column start from pixel 0 and get padded with spaces to reach `rightColumnStartPx`. This creates a visual "indentation" from the left edge - which is the correct behavior for a two-column layout.

3. **Pixel alignment verified**: Test output shows all lines are aligned within tolerance:

   ```
   Line 0: Expected 316px, Actual 316px ✅
   Line 1: Expected 316px, Actual 316px ✅
   Line 2: Expected 316px, Actual 318px ✅ (2px error, within 1 space width)
   ```

4. **Potential issues to investigate**:
   - Preview (GlassesDisplayMirror) uses different font than glasses, so space alignment looks different
   - Native may still be processing `double_text_wall` separately in some code paths
   - Dashboard app content structure may need adjustment

**Debug tools added:**

- `cloud/packages/apps/line-width` - Updated with double_text_wall testing
  - `POST /api/send-double-text-wall` - Send two-column layout
  - `GET /api/test-presets/dashboard` - Dashboard-like test content
- `cloud/packages/display-utils/test-column-composer.ts` - Pixel alignment verification

**Next steps:**

- [ ] Test with line-width app on actual glasses to verify alignment
- [ ] Check if native is double-processing double_text_wall events
- [ ] Consider updating GlassesDisplayMirror to show composed text_wall instead of separate columns

### Future: Profile Updates

When hardware specs become available:

- [x] Update `Z100_PROFILE` with actual Vuzix Z100 font metrics ✅
- [ ] Update `NEX_PROFILE` with actual Mentra Nex font metrics
- [ ] Add `MACH1_PROFILE` if Mentra Mach1 has a display

## Status Checklist

- [x] Problem identified
- [x] Investigation complete
- [x] Spec written
- [x] Architecture designed
- [x] **Phase 1: DisplayProcessor implementation** ✅
  - [x] Create shared `@mentra/display-utils` package
  - [x] Create DisplayProcessor class
  - [x] Integrate with SocketComms
  - [x] Update device model on glasses connect
  - [x] Add G1, Z100, NEX profiles
- [x] **Phase 2: Native SGC wrapping removal** ✅
  - [x] Simplified `G1Text.swift` createTextWallChunks (no re-wrapping)
  - [x] Simplified `G1.java` createTextWallChunks (no re-wrapping)
  - [x] Fixed displayEvent() head-up update bug in iOS/Android CoreManager
- [x] **Phase 2.5: ColumnComposer for double_text_wall** ✅
  - [x] Created ColumnComposer class in display-utils
  - [x] Updated DisplayProcessor to use ColumnComposer
- [x] **Phase 3: Validation** ✅
  - [x] App builds and runs successfully
  - [x] DisplayProcessor integrated and working
  - [x] No runtime errors
- [x] **Phase 4: Z100 Profile Update** ✅
  - [x] Extracted real Noto Sans font metrics
  - [x] Created extract-font-metrics.js utility script
- [x] **Phase 5: Hyphen-Free Word Breaking** ✅
  - [x] Added `character-no-hyphen` break mode
  - [x] Changed default break mode from `character` to `character-no-hyphen`
  - [x] Updated all toolkit factory functions
- [x] **Phase 6: Placeholder Replacement Migration** ✅
  - [x] Added `replacePlaceholders()` to DisplayProcessor
  - [x] Placeholders replaced BEFORE wrapping (correct measurements)
  - [x] Supports $TIME12$, $TIME24$, $DATE$, $GBATT$, $CONNECTION_STATUS$
- [ ] **Phase 7: Double Text Wall Alignment** 🔄
  - [x] Algorithm verified correct
  - [x] Debug tools added to line-width app
  - [ ] Test on actual glasses
  - [ ] Verify native isn't double-processing

## References

- `cloud/packages/display-utils/` - Shared display-utils package
- `cloud/packages/sdk/src/display-utils.ts` - SDK re-export
- `mobile/src/services/display/` - Mobile DisplayProcessor
- `mobile/src/components/mirror/GlassesDisplayMirror.tsx` - Preview component
- `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/` - Native SGC code
