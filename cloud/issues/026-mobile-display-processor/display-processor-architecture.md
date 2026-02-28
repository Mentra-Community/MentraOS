# Display Processor Architecture

This document describes the implementation details of the Mobile Display Processor system.

## Overview

The Display Processor intercepts all display events in the React Native layer and applies pixel-accurate text wrapping before sending them to the native SGC (Smart Glasses Communicator) layer. This ensures consistent text rendering across all platforms and eliminates the need for native-side text wrapping.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLOUD                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐                │
│  │  Cloud App  │───▶│ display-utils │───▶│ Pre-wrapped text │               │
│  │  (Captions) │    │  (wrapping)   │    │  via WebSocket   │               │
│  └─────────────┘    └──────────────┘    └────────┬────────┘                │
└──────────────────────────────────────────────────┼──────────────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MOBILE (React Native)                               │
│                                                                             │
│  ┌─────────────────┐    ┌───────────────────┐    ┌────────────────────┐   │
│  │  WebSocket      │───▶│   SocketComms     │───▶│  DisplayProcessor  │   │
│  │  (cloud events) │    │ handle_display_   │    │  processDisplay-   │   │
│  └─────────────────┘    │ event()           │    │  Event()           │   │
│                         └───────────────────┘    └─────────┬──────────┘   │
│                                                            │              │
│  ┌─────────────────┐    ┌───────────────────┐              │              │
│  │  MantleManager  │───▶│   SocketComms     │──────────────┘              │
│  │  (local/offline │    │ handle_display_   │                             │
│  │   apps)         │    │ event()           │                             │
│  └─────────────────┘    └───────────────────┘                             │
│                                                                           │
│                         ┌───────────────────┐    ┌────────────────────┐   │
│                         │  Zustand Store    │◀───│  GlassesDisplay-   │   │
│                         │  (useDisplayStore)│    │  Mirror (preview)  │   │
│                         └───────────────────┘    └────────────────────┘   │
│                                  │                                         │
│                                  ▼                                         │
│                         ┌───────────────────┐                             │
│                         │  CoreModule.      │                             │
│                         │  displayEvent()   │                             │
│                         └─────────┬─────────┘                             │
└───────────────────────────────────┼─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NATIVE (Kotlin/Swift)                               │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        SGC Manager                                   │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  │   │
│  │  │   G1    │  │  Mach1  │  │  Z100   │  │   Nex   │  │ Simulated│  │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘  │   │
│  └───────┼────────────┼────────────┼────────────┼────────────┼────────┘   │
│          │            │            │            │            │            │
│          ▼            ▼            ▼            ▼            ▼            │
│      ┌───────────────────────────────────────────────────────────┐       │
│      │              BLE / Hardware Communication                  │       │
│      │           (Render pre-wrapped text as-is)                  │       │
│      └───────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Package Structure

### @mentra/display-utils (Shared Package)

Location: `cloud/packages/display-utils/`

```
display-utils/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                 # Main exports + factory functions
    ├── profiles/
    │   ├── index.ts             # Profile exports
    │   ├── types.ts             # DisplayProfile interface
    │   ├── g1.ts                # Even Realities G1 profile
    │   ├── z100.ts              # Vuzix Z100 profile (placeholder)
    │   └── nex.ts               # Mentra Nex profile (placeholder)
    ├── measurer/
    │   ├── index.ts
    │   ├── TextMeasurer.ts      # Pixel-accurate text measurement
    │   └── script-detection.ts  # CJK/Korean/Cyrillic detection
    ├── wrapper/
    │   ├── index.ts
    │   ├── TextWrapper.ts       # Text wrapping with break modes
    │   └── types.ts             # WrapOptions, WrapResult, etc.
    └── helpers/
        ├── index.ts
        ├── DisplayHelpers.ts    # Truncation, pagination, chunking
        └── ScrollView.ts        # Scrollable content management
```

### Mobile Display Service

Location: `mobile/src/services/display/`

```
display/
├── index.ts                     # Service exports
└── DisplayProcessor.ts          # Main processor class
```

## Key Components

### 1. DisplayProcessor

The central component that processes all display events.

```typescript
// mobile/src/services/display/DisplayProcessor.ts

class DisplayProcessor {
  private measurer: TextMeasurer
  private wrapper: TextWrapper
  private profile: DisplayProfile
  private deviceModel: DeviceModel
  
  // Singleton instance
  static getInstance(): DisplayProcessor
  
  // Set device profile when glasses connect
  setDeviceModel(modelName: string): void
  
  // Process display event before sending to native
  processDisplayEvent(event: DisplayEvent): ProcessedDisplayEvent
  
  // Direct text wrapping
  wrapText(text: string, options?: WrapOptions): string[]
  
  // Measure text width
  measureText(text: string): number
}
```

### 2. Device Profiles

Hardware-specific configurations for different glasses.

```typescript
// @mentra/display-utils/src/profiles/types.ts

interface DisplayProfile {
  id: string                    // e.g., "even-realities-g1"
  name: string                  // e.g., "Even Realities G1"
  displayWidthPx: number        // Display width in pixels (576 for G1)
  maxLines: number              // Maximum display lines (5 for G1)
  maxPayloadBytes: number       // BLE payload limit (390 for G1)
  bleChunkSize: number          // BLE chunk size (176 for G1)
  fontMetrics: FontMetrics      // Glyph widths and render formula
  constraints: DisplayConstraints
}
```

### 3. Device Model Mapping

Maps model name strings to profiles.

| Input String | DeviceModel | Profile |
|--------------|-------------|---------|
| `"Even Realities G1"`, `"g1"` | `g1` | `G1_PROFILE` |
| `"Vuzix Z100"`, `"z100"`, `"vuzix"` | `z100` | `Z100_PROFILE` |
| `"Mentra Nex"`, `"nex"`, `"mentra display"` | `nex` | `NEX_PROFILE` |
| `"Mentra Mach1"`, `"mach1"` | `mach1` | `G1_PROFILE` (fallback) |
| `"Mentra Live"`, `"mentra-live"` | `mentra-live` | `G1_PROFILE` (no display) |
| `"Simulated Glasses"`, `"simulated"` | `simulated` | `G1_PROFILE` |

## Data Flow

### 1. Cloud Events (via WebSocket)

```
WebSocket message
    ↓
SocketComms.handle_message()
    ↓
SocketComms.handle_display_event(msg)
    ↓
displayProcessor.processDisplayEvent(msg)  ← WRAPPING HAPPENS HERE
    ↓
CoreModule.displayEvent(processedEvent)    → To native SGC
    ↓
useDisplayStore.setDisplayEvent()          → To preview UI
```

### 2. Local/Offline Events

```
Local STT / Offline App
    ↓
MantleManager.displayTextMain(text)
    ↓
socketComms.handle_display_event({...})
    ↓
displayProcessor.processDisplayEvent(msg)  ← WRAPPING HAPPENS HERE
    ↓
CoreModule.displayEvent(processedEvent)    → To native SGC
    ↓
useDisplayStore.setDisplayEvent()          → To preview UI
```

### 3. Device Model Updates

```
Native glasses connect
    ↓
MantleBridge receives "version_info"
    ↓
displayProcessor.setDeviceModel(data.device_model)
    ↓
DisplayProcessor updates internal profile
```

## Layout Type Processing

### text_wall / text_line

```typescript
processTextWall(event, layout) {
  const text = layout.text || ""
  const lines = this.wrapText(text)  // Pixel-accurate wrapping
  return {
    ...event,
    text: lines.join("\n"),
    _processed: true,
    _lines: lines
  }
}
```

### reference_card

```typescript
processReferenceCard(event, layout) {
  const title = layout.title || ""
  const text = layout.text || ""
  
  // Title gets 1 line, text gets remaining
  const wrappedTitle = this.wrapText(title, { maxLines: 1 })
  const wrappedText = this.wrapText(text, { maxLines: maxLines - 1 })
  
  return {
    ...event,
    title: wrappedTitle.join("\n"),
    text: wrappedText.join("\n"),
    _processed: true
  }
}
```

### double_text_wall

```typescript
processDoubleTextWall(event, layout) {
  // Each column gets ~50% width
  const halfWidth = Math.floor(displayWidthPx / 2) - 10
  
  const wrappedTop = this.wrapText(topText, { maxWidthPx: halfWidth })
  const wrappedBottom = this.wrapText(bottomText, { maxWidthPx: halfWidth })
  
  return {
    ...event,
    topText: wrappedTop.join("\n"),
    bottomText: wrappedBottom.join("\n"),
    _processed: true
  }
}
```

### text_rows

```typescript
processTextRows(event, layout) {
  const rows = layout.text || []  // string[]
  
  // Wrap each row independently
  const wrappedRows = rows.map(row => {
    const lines = this.wrapText(row)
    return lines.join("\n")
  })
  
  return {
    ...event,
    text: wrappedRows,
    _processed: true
  }
}
```

### bitmap_view

No processing needed - passed through as-is.

## Native SGC Status

### Current State

After investigation, the native SGC layer has minimal text wrapping:

**Android:**
- `G1.kt` - No text wrapping logic found
- `Mach1.java` - Has `addNewlineEveryNWords()` helper (for Vuzix SDK compatibility)
- Other SGCs - No wrapping logic

**iOS:**
- `G1.swift` - No text wrapping logic
- `MentraLive.swift` - No text wrapping (only protocol wrapping)
- Other SGCs - No wrapping logic

### Recommendation

The native layer is already mostly acting as a "dumb renderer". The `Mach1.java` has some wrapping for Vuzix SDK compatibility, but this is specific to that hardware's SDK requirements.

**No immediate changes needed** - the DisplayProcessor in RN handles all wrapping before events reach native code.

## Integration Points

### 1. SocketComms.ts

```typescript
// mobile/src/services/SocketComms.ts

import { displayProcessor } from "@/services/display"

public handle_display_event(msg: any) {
  if (!msg.view) {
    console.error("SOCKET: display_event missing view")
    return
  }

  // Process through DisplayProcessor for pixel-accurate wrapping
  const processedEvent = displayProcessor.processDisplayEvent(msg)

  // Send to native SGC
  CoreModule.displayEvent(processedEvent)

  // Update store for preview
  const displayEventStr = JSON.stringify(processedEvent)
  useDisplayStore.getState().setDisplayEvent(displayEventStr)
}
```

### 2. MantleBridge.tsx

```typescript
// mobile/src/bridge/MantleBridge.tsx

import { displayProcessor } from "@/services/display"

case "version_info":
  useGlassesStore.getState().setGlassesInfo({
    modelName: data.device_model,
    // ... other fields
  })
  // Update DisplayProcessor with connected glasses model
  displayProcessor.setDeviceModel(data.device_model)
  break
```

### 3. Package Configuration

**mobile/tsconfig.json:**
```json
{
  "compilerOptions": {
    "paths": {
      "@mentra/display-utils": ["../cloud/packages/display-utils/src"]
    }
  }
}
```

**mobile/babel.config.cts:**
```typescript
alias: {
  "@mentra/display-utils": "../cloud/packages/display-utils/src"
}
```

**mobile/metro.config.js:**
```javascript
config.watchFolders = [
  path.resolve(__dirname, "../cloud/packages/display-utils/src")
]
```

## Testing Strategy

### Unit Tests

1. **DisplayProcessor.processDisplayEvent()** - Test all layout types
2. **DisplayProcessor.wrapText()** - Test wrapping accuracy
3. **normalizeModelName()** - Test model name mapping

### Integration Tests

1. Cloud event → Preview matches expected output
2. Local event → Preview matches expected output
3. Device model change → Profile updates correctly

### Manual Testing

1. Connect glasses, verify model detection
2. Run captions app, compare preview vs glasses
3. Test CJK/Korean/Cyrillic text
4. Test long text that spans multiple lines

## Future Considerations

### Profile Updates

When hardware becomes available:
- Update `Z100_PROFILE` with actual Vuzix Z100 font metrics
- Update `NEX_PROFILE` with actual Mentra Nex font metrics
- Add `MACH1_PROFILE` if Mach1 has a display

### Performance

- DisplayProcessor runs synchronously on every display event
- For high-frequency updates (e.g., live captions), monitor performance
- Consider caching wrapped results for repeated text

### Break Mode Configuration

Currently hardcoded to `character` break mode. Could expose this in settings:
- `character` - Break mid-word with hyphen (100% line utilization)
- `word` - Break at word boundaries (cleaner but lower utilization)
- `strict-word` - Never hyphenate (may overflow)