# Issue 026b: Double Text Wall Alignment Investigation

**Status**: Under Investigation 🔄  
**Priority**: High  
**Related**: Issue 026, DisplayProcessor, ColumnComposer, Dashboard App

## Problem Description

The dashboard view shows misaligned columns in the `double_text_wall` layout. Users report:

1. "Top right and bottom right quadrants are not lined up"
2. "Word breaks cause indentation on the next line"

## How Double Text Wall Works

### Layout Structure

`double_text_wall` is a two-column layout used primarily by the Dashboard:

```
┌─────────────────────────────────────────────────────┐
│ LEFT COLUMN (topText)     │ RIGHT COLUMN (bottomText)│
│ - Time/Battery            │ - Calendar/Status        │
│ - Notifications           │ - App content            │
│                           │ - Weather, etc.          │
└─────────────────────────────────────────────────────┘
```

**Note**: The API naming is confusing - `topText` is the LEFT column, `bottomText` is the RIGHT column.

### Dashboard Content Assembly

The Dashboard app (cloud/packages/apps/Dashboard) sets four system sections:

```typescript
session.dashboard.system?.setTopLeft(topLeftText) // Time, battery
session.dashboard.system?.setTopRight(topRight) // Status/calendar
session.dashboard.system?.setBottomLeft(bottomLeft) // Notifications
session.dashboard.system?.setBottomRight("") // Usually empty
```

The DashboardManager then assembles these into a `double_text_wall`:

```typescript
// Left column = topLeft + "\n" + bottomLeft
const leftText = `${this.systemContent.topLeft}\n${this.systemContent.bottomLeft}`

// Right column = topRight + "\n" + bottomRight + "\n\n" + appContent
const rightText = `${this.systemContent.topRight}\n${this.systemContent.bottomRight}\n\n${appContent}`

return {
  layoutType: LayoutType.DOUBLE_TEXT_WALL,
  topText: leftText, // Left column
  bottomText: rightText, // Right column
}
```

### Processing Pipeline

1. **Cloud** sends `double_text_wall` with `topText` and `bottomText`
2. **DisplayProcessor** (React Native) receives the event
3. **ColumnComposer** wraps each column independently, then merges line-by-line
4. **Output** is converted to `text_wall` with pre-composed text
5. **Native** receives `text_wall` and just chunks/sends it

## Column Composition Algorithm

### Configuration (G1 Profile)

```
Display width:     576px (100%)
Left column width: 288px (50%)
Right column start: 316px (55%)
Right column width: 260px (45%)
Gap between columns: 28px (5%)
```

### Merging Process

For each line (up to `maxLines` = 5):

1. Take left column text for this line
2. Measure its pixel width
3. Calculate spaces needed to reach `rightColumnStartPx` (316px)
4. Append spaces and right column text for this line

```
Line 0: "1:30 PM, 85%"                    + [33 spaces] + "Meeting @ 2pm"
Line 1: "John: Hey are you free?"         + [17 spaces] + "Weather: 72°F Sunny with cl"
Line 2: ""                                + [53 spaces] + "ear skies expected througho"
Line 3: ""                                + [53 spaces] + "ut the afternoon"
Line 4: ""                                + [53 spaces] + ""
```

### The "Indentation" Effect

When the left column has fewer lines than the right column:

```
Line 0: |LEFT CONTENT          |  RIGHT CONTENT       |
Line 1: |LEFT CONTENT          |  RIGHT CONTENT       |
Line 2: |                      |  RIGHT CONTINUATION  |  ← Looks "indented"
Line 3: |                      |  MORE RIGHT TEXT     |  ← Looks "indented"
```

**This is EXPECTED behavior** for a two-column layout. The right column text always starts at pixel 316, regardless of what's in the left column.

## Investigation Findings

### 1. Algorithm is Correct ✅

Test output confirms pixel-perfect alignment:

```
Line 0: Expected 316px, Actual 316px, Error: 0px ✅
Line 1: Expected 316px, Actual 316px, Error: 0px ✅
Line 2: Expected 316px, Actual 318px, Error: 2px ✅ (within tolerance)
Line 3: Expected 316px, Actual 318px, Error: 2px ✅ (within tolerance)
```

The 2px error on lines 2-3 is due to integer rounding in space calculation and is within one space width (6px).

### 2. Native Code Matches

The ColumnComposer algorithm exactly matches the native iOS/Android implementation:

**iOS (G1Text.swift)**:

```swift
let spacesNeeded = calculateSpacesForAlignment(
    currentWidth: leftTextWidth,
    targetPosition: RIGHT_COLUMN_START,
    spaceWidth: spaceWidth
)
pageText.append(leftText)
pageText.append(String(repeating: " ", count: spacesNeeded))
pageText.append(rightText)
```

**TypeScript (ColumnComposer.ts)**:

```typescript
const spacesNeeded = this.calculateSpacesForAlignment(leftWidthPx, config.rightColumnStartPx)
line += leftText
line += " ".repeat(spacesNeeded)
line += rightText
```

### 3. Potential Issues

#### A. Preview Mismatch

The `GlassesDisplayMirror` component uses a different font than the glasses:

- Glasses: Fixed-width pixel font with known glyph widths
- Preview: System font (variable width)

Space alignment that looks correct on glasses may look wrong on phone.

#### B. Native Double-Processing

Native `CoreManager.swift` still has code to handle `double_text_wall`:

```swift
case "double_text_wall":
    let topText = currentViewState.topText
    let bottomText = currentViewState.bottomText
    sgc?.sendDoubleTextWall(topText, bottomText)
```

But DisplayProcessor changes the layout type to `text_wall`, so this code path shouldn't be hit. However, if the `layout.layoutType` doesn't get updated correctly, native might still process it as `double_text_wall`.

#### C. Native Placeholder Replacement

Native still calls `parsePlaceholders()`:

```swift
text = parsePlaceholders(text)
topText = parsePlaceholders(topText)
bottomText = parsePlaceholders(bottomText)
```

This happens AFTER DisplayProcessor has already replaced placeholders. While this should be a no-op (no placeholders left), it's unnecessary work.

## Debug Tools

### Line Width App

Updated `cloud/packages/apps/line-width` with new endpoints:

```bash
# Send double_text_wall
curl -X POST http://localhost:3333/api/send-double-text-wall \
  -H "Content-Type: application/json" \
  -d '{"topText": "Left column", "bottomText": "Right column"}'

# Get dashboard test presets
curl http://localhost:3333/api/test-presets/dashboard

# Clear display
curl -X POST http://localhost:3333/api/clear-display
```

### Test Presets

| Preset                | Description                                       |
| --------------------- | ------------------------------------------------- |
| Simple Dashboard      | Basic time/battery + status                       |
| With Notification     | Left has notification, right has status + weather |
| Long Right Content    | Tests wrapping in right column                    |
| Both Columns Long     | Both columns need wrapping                        |
| Empty Left            | Only right column has content                     |
| Alignment Stress Test | Narrow vs wide characters                         |

### Column Composer Test

Run pixel alignment verification:

```bash
cd cloud/packages/display-utils
npx tsx test-column-composer.ts
```

Output shows exact pixel widths and alignment errors for each line.

## Recommendations

### Short Term

1. **Test on actual glasses** using line-width app to verify alignment
2. **Add logging** to native to verify it receives `text_wall` not `double_text_wall`
3. **Remove native placeholder parsing** for pre-processed text

### Medium Term

1. **Update GlassesDisplayMirror** to render composed `text_wall` instead of separate columns
2. **Add visual debug mode** that shows pixel positions on preview

### Long Term

1. **Consider removing `double_text_wall`** from native entirely - it's now just a `text_wall` with pre-composed content
2. **Standardize on single processing path** - all layout composition in DisplayProcessor

## Test Cases

### Manual Test: Dashboard Alignment

1. Connect glasses to MentraOS app
2. Start line-width app: `cd cloud/packages/apps/line-width && bun run dev`
3. Open http://localhost:3333
4. Connect glasses to the app
5. Use test presets to send various `double_text_wall` layouts
6. Observe alignment on glasses (not phone preview)
7. Document any misalignment with specific content that causes it

### Automated Test: Pixel Alignment

```typescript
// test-column-alignment.ts
import {ColumnComposer} from "./src/composer/ColumnComposer"
import {G1_PROFILE} from "./src/profiles/g1"
import {TextMeasurer} from "./src/measurer/TextMeasurer"

const composer = new ColumnComposer(G1_PROFILE, "character-no-hyphen")
const measurer = new TextMeasurer(G1_PROFILE)
const config = composer.getDefaultColumnConfig()

// Test case: right column wraps, left column doesn't
const result = composer.composeDoubleTextWall(
  "Short left",
  "Long right content that will definitely wrap to multiple lines",
)

// Verify each line's right column starts at correct position
result.composedText.split("\n").forEach((line, i) => {
  const leftWidth = measurer.measureText(result.leftLines[i] || "")
  const spacesInLine = (line.match(/ +/) || [""])[0].length
  const actualStart = leftWidth + spacesInLine * measurer.measureText(" ")

  const error = Math.abs(actualStart - config.rightColumnStartPx)
  console.assert(error <= 6, `Line ${i} misaligned by ${error}px`)
})
```

## Related Files

- `cloud/packages/display-utils/src/composer/ColumnComposer.ts` - Column composition
- `mobile/src/services/display/DisplayProcessor.ts` - Event processing
- `mobile/modules/core/ios/Source/CoreManager.swift` - Native event handling
- `mobile/modules/core/ios/Source/utils/G1Text.swift` - Native column composition (legacy)
- `cloud/packages/apps/line-width/src/index.ts` - Debug app
- `cloud/packages/apps/Dashboard/src/index.ts` - Dashboard app
