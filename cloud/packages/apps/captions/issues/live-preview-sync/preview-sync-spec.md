# Live Preview Sync Spec

## Overview

Stream the exact display content shown on glasses to the webview settings preview via SSE, so users see a real-time mirror of their captions.

## Problem

### 1. Static Preview

Settings page shows hardcoded text that doesn't reflect actual captions:

```tsx
// Settings.tsx L56-60
<p className="text-gray-800 text-lg font-['Red_Hat_Display'] leading-relaxed">
  Understood. We're deciding between the options on page 3 and page 4, right?
</p>
```

### 2. Bug in `convertLineWidth`

The function doesn't handle the numeric enum values (0, 1, 2) from settings:

```typescript
// convertLineWidth.ts L7-9
export function convertLineWidth(width: string | number, isHanzi: boolean): number {
  if (typeof width === "number") return width  // BUG: Returns 0, 1, 2 directly!
```

When `width` is `0` (enum for Narrow), it returns `0` characters instead of `38`.

**Enum mapping needed:**
| Enum | Label  | Non-Hanzi | Hanzi |
|------|--------|-----------|-------|
| 0    | Narrow | 38 chars  | 14    |
| 1    | Medium | 44 chars  | 18    |
| 2    | Wide   | 52 chars  | 21    |

### 3. No Data Path to Preview

```
DisplayManager.showOnGlasses() → glasses via SDK
                              → (nothing to webview)
```

## Goals

1. Fix `convertLineWidth` to handle numeric enum values
2. Broadcast display content to webview via existing SSE
3. Update preview component to show live data
4. Match styling between preview and glasses display

## Non-Goals

- Changing the glasses display format
- Adding new SSE connection (use existing TranscriptsManager)
- Complex preview animations

## Design

### Data Flow

```
Transcription → DisplayManager.processAndDisplay()
                      ↓
               TranscriptProcessor.processString()
                      ↓
               DisplayManager.showOnGlasses()
                      ↓
         ┌──────────┴──────────┐
         ↓                     ↓
   glasses (SDK)         SSE broadcast
                               ↓
                    webview Settings preview
```

### SSE Message Format

```typescript
interface DisplayPreviewMessage {
  type: "display_preview"
  text: string        // The full formatted text as shown on glasses
  lines: string[]     // Text split by lines for easier rendering
  isFinal: boolean    // Whether this is a final transcript
  timestamp: number   // When this was displayed
}
```

### Preview Behavior

| State | Preview Shows |
|-------|---------------|
| Active transcription | Live text matching glasses |
| No recent data (>5s) | Last known text |
| Never received data | Placeholder: "Captions will appear here" |

## Implementation

### Phase 1: Fix `convertLineWidth`

**File:** `src/app/utils/text-wrapping/convertLineWidth.ts`

```typescript
export function convertLineWidth(width: string | number, isHanzi: boolean): number {
  // Handle numeric enum values (0=Narrow, 1=Medium, 2=Wide)
  if (typeof width === "number") {
    const enumMap = isHanzi
      ? { 0: 14, 1: 18, 2: 21 }
      : { 0: 38, 1: 44, 2: 52 }
    
    if (width in enumMap) {
      return enumMap[width as 0 | 1 | 2]
    }
    // If it's already a character count, return as-is
    return width
  }

  // Handle string values ("narrow", "medium", "wide")
  if (!isHanzi) {
    switch (width.toLowerCase()) {
      case "narrow": return 38
      case "medium": return 44
      case "wide":   return 52
      default:       return 52
    }
  } else {
    switch (width.toLowerCase()) {
      case "narrow": return 14
      case "medium": return 18
      case "wide":   return 21
      default:       return 21
    }
  }
}
```

### Phase 2: Add SSE Broadcast

**File:** `src/app/session/TranscriptsManager.ts`

Add method:

```typescript
public broadcastDisplayPreview(text: string, lines: string[], isFinal: boolean): void {
  const message = {
    type: "display_preview",
    text,
    lines,
    isFinal,
    timestamp: Date.now(),
  }

  for (const client of this.sseClients) {
    try {
      client.send(message)
    } catch (error) {
      this.logger.error(`Failed to send display preview: ${error}`)
    }
  }
}
```

**File:** `src/app/session/DisplayManager.ts`

Update `showOnGlasses`:

```typescript
private showOnGlasses(text: string, isFinal: boolean): void {
  const cleaned = this.cleanTranscriptText(text)
  const lines = cleaned.split("\n")

  this.logger.info(
    `Showing on glasses: "${cleaned}" (final: ${isFinal})`,
  )

  // Send to glasses
  this.userSession.appSession.layouts.showTextWall(cleaned, {
    view: ViewType.MAIN,
    durationMs: isFinal ? 20000 : undefined,
  })

  // Broadcast to webview preview
  this.userSession.transcripts.broadcastDisplayPreview(cleaned, lines, isFinal)
}
```

### Phase 3: Webview Updates

**File:** `src/webview/hooks/useTranscripts.ts`

Add state and handler:

```typescript
const [displayPreview, setDisplayPreview] = useState<{
  text: string
  lines: string[]
  isFinal: boolean
  timestamp: number
} | null>(null)

// In SSE message handler:
if (data.type === "display_preview") {
  setDisplayPreview({
    text: data.text,
    lines: data.lines,
    isFinal: data.isFinal,
    timestamp: data.timestamp,
  })
  return
}

// Return in hook:
return {
  // ... existing
  displayPreview,
}
```

**File:** `src/webview/components/Settings.tsx`

Update preview section:

```tsx
interface SettingsProps {
  settings: CaptionSettings | null
  displayPreview: { text: string; lines: string[]; isFinal: boolean } | null
  onUpdateDisplayLines: (lines: number) => Promise<boolean>
  onUpdateDisplayWidth: (width: number) => Promise<boolean>
}

// In component:
{/* Preview Section */}
<div className="space-y-3">
  <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
    Preview
  </h3>
  <div className="p-6 bg-white rounded-2xl shadow-sm border border-gray-100 min-h-[120px]">
    {displayPreview?.text ? (
      <div className="space-y-1">
        {displayPreview.lines.map((line, i) => (
          <p
            key={i}
            className={`text-lg font-['Red_Hat_Display'] leading-relaxed ${
              displayPreview.isFinal ? "text-gray-800" : "text-gray-500"
            }`}
          >
            {line || "\u00A0"} {/* Non-breaking space for empty lines */}
          </p>
        ))}
      </div>
    ) : (
      <p className="text-gray-400 text-lg font-['Red_Hat_Display'] leading-relaxed italic">
        Captions will appear here
      </p>
    )}
  </div>
</div>
```

## Files to Modify

| File | Change |
|------|--------|
| `src/app/utils/text-wrapping/convertLineWidth.ts` | Fix numeric enum handling |
| `src/app/session/DisplayManager.ts` | Add SSE broadcast after showOnGlasses |
| `src/app/session/TranscriptsManager.ts` | Add `broadcastDisplayPreview()` method |
| `src/webview/hooks/useTranscripts.ts` | Handle `display_preview` message, add state |
| `src/webview/components/Settings.tsx` | Replace static preview with live data |
| `src/webview/App.tsx` | Pass displayPreview prop to Settings |

## Open Questions

1. **Should we limit preview broadcast rate?**
   - Current debounce in DisplayManager (400ms) should be sufficient
   - No additional throttling needed

2. **Clear preview on inactivity?**
   - Keep last known text visible (user preference)
   - Only show placeholder if never received data